#!/usr/bin/env bash
# Deploy Whorl to AWS: the app runs on Lambda behind a public Function URL,
# riders sign in with accounts kept in a Cognito user pool, and each rider's
# workouts, uploads, favorites and rides live in S3 under users/<id>/.
#
#   ./deploy.sh
#
# Safe to re-run: the first run creates everything, later runs push new code.
# AWS_PROFILE defaults to "quin" and AWS_REGION to us-east-1. The invite code
# new riders need to sign up comes from WHORL_INVITE_CODE or invite-code.txt,
# and is required; change it and re-run to change it on the live site.
set -euo pipefail
cd "$(dirname "$0")"

export AWS_PROFILE="${AWS_PROFILE:-quin}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""
# The AWS resources keep the names they were created with (the app was called
# Quinvy then). Renaming them here would make this script create new, empty
# ones: a new URL, a new bucket without riders' data, a pool without accounts.
FUNCTION=quinvy
ROLE=quinvy-lambda
POOL_NAME=quinvy
CLIENT_NAME=quinvy-web

INVITE_CODE="${WHORL_INVITE_CODE:-$(cat invite-code.txt 2>/dev/null || true)}"
INVITE_CODE="$(printf %s "$INVITE_CODE" | tr -d '\r\n')"
if [ -z "$INVITE_CODE" ]; then
  echo "No invite code: put one in invite-code.txt or set WHORL_INVITE_CODE." >&2
  exit 1
fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="quinvy-data-$ACCOUNT"
echo "Deploying to account $ACCOUNT, $AWS_REGION (profile $AWS_PROFILE)"

# ---- 1. S3 bucket for rider data: private, versioned so deletes can be undone ----
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "Creating bucket $BUCKET"
  if [ "$AWS_REGION" = us-east-1 ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration \
    '{"Rules":[{"ID":"expire-old-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}' >/dev/null
fi

# ---- 2. IAM role: CloudWatch logs + this bucket only ----
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "Creating role $ROLE"
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name quinvy-data --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$BUCKET\"},
    {\"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\"], \"Resource\": \"arn:aws:s3:::$BUCKET/*\"}
  ]
}"
ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)

# ---- 3. Package: server code, web app, bundled presets (not uploads) ----
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$BUILD/pkg/presets"
cp server.py storage.py accounts.py lambda_function.py "$BUILD/pkg/"
cp -R public "$BUILD/pkg/public"
for dir in presets/*/; do
  [ "$(basename "$dir")" = uploaded ] || cp -R "${dir%/}" "$BUILD/pkg/presets/"
done
(cd "$BUILD/pkg" && zip -qr ../function.zip . -x '*.DS_Store')

# Sessions are signed with this secret. Keep the live one so a deploy doesn't
# sign everyone out; make one on the first deploy.
SESSION_SECRET=$(aws lambda get-function-configuration --function-name "$FUNCTION" \
  --query Environment.Variables.WHORL_SESSION_SECRET --output text 2>/dev/null || true)
if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = None ]; then
  SESSION_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
fi
write_env() { # pool id, client id (empty until the pool exists)
  python3 -c 'import json, sys; b, s, i, p, c = sys.argv[1:]; v = {"WHORL_BUCKET": b, "WHORL_SESSION_SECRET": s, "WHORL_INVITE_CODE": i}
if p and c: v.update(WHORL_COGNITO_POOL=p, WHORL_COGNITO_CLIENT=c)
print(json.dumps({"Variables": v}))' "$BUCKET" "$SESSION_SECRET" "$INVITE_CODE" "$1" "$2" >"$BUILD/env.json"
}
POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)
[ "$POOL_ID" = None ] && POOL_ID=""
CLIENT_ID=""
if [ -n "$POOL_ID" ]; then
  CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 \
    --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" --output text)
  [ "$CLIENT_ID" = None ] && CLIENT_ID=""
fi
write_env "$POOL_ID" "$CLIENT_ID"

# ---- 4. Lambda function ----
if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
  echo "Updating function $FUNCTION"
  aws lambda update-function-code --function-name "$FUNCTION" --zip-file "fileb://$BUILD/function.zip" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION"
  aws lambda update-function-configuration --function-name "$FUNCTION" --environment "file://$BUILD/env.json" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION"
else
  echo "Creating function $FUNCTION"
  # A brand-new role takes a few seconds before Lambda is allowed to use it.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if aws lambda create-function --function-name "$FUNCTION" --runtime python3.12 --architectures arm64 \
      --handler lambda_function.handler --role "$ROLE_ARN" --zip-file "fileb://$BUILD/function.zip" \
      --timeout 15 --memory-size 256 --environment "file://$BUILD/env.json" >/dev/null 2>"$BUILD/err"; then
      break
    fi
    grep -q "cannot be assumed" "$BUILD/err" && [ "$attempt" -lt 10 ] || { cat "$BUILD/err" >&2; exit 1; }
    sleep 5
  done
  aws lambda wait function-active --function-name "$FUNCTION"
fi

FUNCTION_ARN=$(aws lambda get-function --function-name "$FUNCTION" --query Configuration.FunctionArn --output text)

# ---- 5. Accounts: Cognito user pool, with the invite code checked at sign-up ----
if [ -z "$POOL_ID" ]; then
  echo "Creating user pool $POOL_NAME"
  POOL_ID=$(aws cognito-idp create-user-pool --pool-name "$POOL_NAME" \
    --username-attributes email --username-configuration CaseSensitive=false \
    --auto-verified-attributes email \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=false,RequireLowercase=false,RequireNumbers=false,RequireSymbols=false}' \
    --account-recovery-setting 'RecoveryMechanisms=[{Priority=1,Name=verified_email}]' \
    --admin-create-user-config AllowAdminCreateUserOnly=false \
    --verification-message-template '{"DefaultEmailOption":"CONFIRM_WITH_CODE","EmailSubject":"Your Whorl code","EmailMessage":"Your Whorl code is {####}"}' \
    --lambda-config "PreSignUp=$FUNCTION_ARN" \
    --user-pool-tier LITE --deletion-protection ACTIVE \
    --query UserPool.Id --output text)
fi
if [ -z "$CLIENT_ID" ]; then
  echo "Creating app client $CLIENT_NAME"
  CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name "$CLIENT_NAME" \
    --no-generate-secret --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED --enable-token-revocation \
    --query UserPoolClient.ClientId --output text)
fi
POOL_ARN=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" --query UserPool.Arn --output text)
POLICY=$(aws lambda get-policy --function-name "$FUNCTION" --query Policy --output text 2>/dev/null || true)
if ! grep -q '"cognito-presignup"' <<<"$POLICY"; then
  aws lambda add-permission --function-name "$FUNCTION" --statement-id cognito-presignup \
    --action lambda:InvokeFunction --principal cognito-idp.amazonaws.com --source-arn "$POOL_ARN" >/dev/null
fi
write_env "$POOL_ID" "$CLIENT_ID"
aws lambda update-function-configuration --function-name "$FUNCTION" --environment "file://$BUILD/env.json" >/dev/null
aws lambda wait function-updated --function-name "$FUNCTION"

# ---- 6. Public HTTPS address (sign-in is inside the app) ----
URL=$(aws lambda get-function-url-config --function-name "$FUNCTION" --query FunctionUrl --output text 2>/dev/null || true)
if [ -z "$URL" ]; then
  URL=$(aws lambda create-function-url-config --function-name "$FUNCTION" --auth-type NONE --query FunctionUrl --output text)
fi
# A public URL needs two statements in the function's policy: InvokeFunctionUrl,
# and (since Oct 2025) InvokeFunction limited to calls made through the URL.
POLICY=$(aws lambda get-policy --function-name "$FUNCTION" --query Policy --output text 2>/dev/null || true)
if ! grep -q '"public-function-url"' <<<"$POLICY"; then
  aws lambda add-permission --function-name "$FUNCTION" --statement-id public-function-url \
    --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE >/dev/null
fi
if ! grep -q '"public-function-url-invoke"' <<<"$POLICY"; then
  if ! aws lambda add-permission help 2>/dev/null | grep -q -- --invoked-via-function-url; then
    echo "Your AWS CLI is too old to finish the public URL (no --invoked-via-function-url)." >&2
    echo "Update it (brew upgrade awscli) and run ./deploy.sh again." >&2
    exit 1
  fi
  aws lambda add-permission --function-name "$FUNCTION" --statement-id public-function-url-invoke \
    --action lambda:InvokeFunction --principal "*" --invoked-via-function-url >/dev/null
fi

echo
echo "Whorl is live: $URL"
