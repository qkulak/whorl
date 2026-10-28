"""Rider accounts, kept in an Amazon Cognito user pool.

Sign-up, sign-in, email confirmation and password reset are Cognito's public
API calls, so they're plain HTTPS requests — no AWS SDK and no AWS credentials.
The tokens come straight back from Cognito over that HTTPS connection, which is
what lets the server read the rider's id from the ID token without checking its
signature; it then hands out its own signed session cookie.

The invite code is checked by Cognito's pre sign-up trigger (handle_trigger),
so it can't be skipped by calling Cognito directly.
"""
import base64
import hmac
import json
import os
import re
import urllib.error
import urllib.request


class AccountError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# Cognito's wording, turned into something a rider can act on.
FRIENDLY = {
    "NotAuthorizedException": "Incorrect email or password.",
    "UsernameExistsException": "There's already an account with this email. Sign in instead.",
    "CodeMismatchException": "That code isn't right. Check the email and try again.",
    "ExpiredCodeException": "That code has expired. Ask for a new one.",
    "LimitExceededException": "Too many attempts. Wait a few minutes and try again.",
    "TooManyRequestsException": "Too many attempts. Wait a few minutes and try again.",
    "TooManyFailedAttemptsException": "Too many attempts. Wait a few minutes and try again.",
    "UserNotConfirmedException": "Confirm your email first. We've sent you a new code.",
    "UserNotFoundException": "Incorrect email or password.",
    "CodeDeliveryFailureException": "We couldn't send the email. Check the address and try again.",
}


def _message(code, raw):
    if code in FRIENDLY:
        return FRIENDLY[code]
    if code == "InvalidPasswordException":
        return re.sub(r"^Password did not conform with policy: ", "", raw).rstrip(".") + "."
    if code == "UserLambdaValidationException":
        # "PreSignUp failed with error That invite code isn't right.."
        return re.sub(r"^\w+ failed with error ", "", raw).rstrip(".") + "."
    if code == "InvalidParameterException":
        return raw
    return "Something went wrong. Try again."


def claims(jwt):
    """The payload of a token Cognito just handed us directly."""
    part = jwt.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))


class Accounts:
    def __init__(self, pool_id, client_id):
        self.client_id = client_id
        self.endpoint = f"https://cognito-idp.{pool_id.split('_')[0]}.amazonaws.com/"

    def _call(self, action, payload):
        req = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload).encode(),
            headers={
                "Content-Type": "application/x-amz-json-1.1",
                "X-Amz-Target": f"AWSCognitoIdentityProviderService.{action}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read() or b"{}")
            except ValueError:
                err = {}
            code = str(err.get("__type", "")).split("#")[-1] or f"HTTP{e.code}"
            raw = err.get("message") or err.get("Message") or ""
            if code not in FRIENDLY and code not in ("InvalidPasswordException", "UserLambdaValidationException"):
                print(f"cognito {action}: {code}: {raw}")
            raise AccountError(code, _message(code, raw)) from None

    def sign_in(self, email, password):
        """Returns {"sub", "email", "access_token"}."""
        out = self._call(
            "InitiateAuth",
            {"AuthFlow": "USER_PASSWORD_AUTH", "ClientId": self.client_id,
             "AuthParameters": {"USERNAME": email, "PASSWORD": password}},
        )
        result = out.get("AuthenticationResult")
        if not result:
            raise AccountError(out.get("ChallengeName", "Challenge"), "This account needs attention. Reset your password.")
        c = claims(result["IdToken"])
        return {"sub": c["sub"], "email": c.get("email", email), "access_token": result["AccessToken"]}

    def sign_up(self, email, password, invite_code):
        self._call(
            "SignUp",
            {"ClientId": self.client_id, "Username": email, "Password": password,
             "UserAttributes": [{"Name": "email", "Value": email}],
             "ClientMetadata": {"inviteCode": invite_code}},
        )

    def confirm(self, email, code):
        self._call("ConfirmSignUp", {"ClientId": self.client_id, "Username": email, "ConfirmationCode": code})

    def resend(self, email):
        self._call("ResendConfirmationCode", {"ClientId": self.client_id, "Username": email})

    def forgot(self, email):
        self._call("ForgotPassword", {"ClientId": self.client_id, "Username": email})

    def reset(self, email, code, password):
        self._call(
            "ConfirmForgotPassword",
            {"ClientId": self.client_id, "Username": email, "ConfirmationCode": code, "Password": password},
        )

    def delete(self, access_token):
        self._call("DeleteUser", {"AccessToken": access_token})


def _norm(code):
    return re.sub(r"\s+", "", str(code or "")).upper()


def handle_trigger(event):
    """Cognito pre sign-up trigger: only riders with the invite code get an account.
    Accounts you add yourself (AdminCreateUser) don't need one."""
    if event.get("triggerSource") == "PreSignUp_SignUp":
        expected = _norm(os.environ.get("WHORL_INVITE_CODE"))
        given = _norm((event.get("request", {}).get("clientMetadata") or {}).get("inviteCode"))
        if not expected or not hmac.compare_digest(given, expected):
            raise Exception("That invite code isn't right.")
    return event
