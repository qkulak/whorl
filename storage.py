"""Where Whorl keeps the files riders change: their workouts, uploads,
favorites and saved rides.

Keys are slash-separated paths such as "workouts/z2-lifts.zwo". Locally they
are files under the project folder; on Lambda (WHORL_BUCKET set) they are
objects in that S3 bucket. The bundled presets never change, so they are read
straight from disk in both cases and don't go through here.
"""
import os
import shutil


class LocalStore:
    def __init__(self, root):
        self.root = root

    def _path(self, key):
        return os.path.join(self.root, *key.split("/"))

    def list(self, prefix):
        """File names directly inside the prefix folder, sorted."""
        folder = self._path(prefix.rstrip("/"))
        if not os.path.isdir(folder):
            return []
        return sorted(n for n in os.listdir(folder) if os.path.isfile(os.path.join(folder, n)))

    def read(self, key):
        try:
            with open(self._path(key), encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError:
            return None

    def write(self, key, text):
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)

    def exists(self, key):
        return os.path.isfile(self._path(key))

    def delete(self, key):
        """Remove the file; False if it wasn't there."""
        try:
            os.remove(self._path(key))
            return True
        except FileNotFoundError:
            return False

    def delete_tree(self, prefix):
        """Remove everything under the prefix folder (a deleted account's data)."""
        assert prefix.strip("/"), "refusing to delete the whole store"
        shutil.rmtree(self._path(prefix.rstrip("/")), ignore_errors=True)


class S3Store:
    def __init__(self, bucket, client=None):
        if client is None:
            import boto3  # bundled with the Lambda Python runtime

            client = boto3.client("s3")
        self.bucket = bucket
        self.s3 = client

    def list(self, prefix):
        prefix = prefix.rstrip("/") + "/"
        names = []
        pages = self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/")
        for page in pages:
            names += [o["Key"][len(prefix):] for o in page.get("Contents", [])]
        return sorted(n for n in names if n)

    def read(self, key):
        try:
            obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        except self.s3.exceptions.NoSuchKey:
            return None
        return obj["Body"].read().decode("utf-8", "replace")

    def write(self, key, text):
        content_type = "application/json" if key.endswith(".json") else "application/xml"
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=text.encode("utf-8"), ContentType=content_type)

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except self.s3.exceptions.ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def delete(self, key):
        if not self.exists(key):
            return False
        self.s3.delete_object(Bucket=self.bucket, Key=key)
        return True

    def delete_tree(self, prefix):
        assert prefix.strip("/"), "refusing to delete the whole store"
        prefix = prefix.rstrip("/") + "/"
        keys = []
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=prefix):
            keys += [{"Key": o["Key"]} for o in page.get("Contents", [])]
        for i in range(0, len(keys), 1000):
            self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": keys[i : i + 1000], "Quiet": True})


def open_store(root):
    bucket = os.environ.get("WHORL_BUCKET")
    return S3Store(bucket) if bucket else LocalStore(root)
