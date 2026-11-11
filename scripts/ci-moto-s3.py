"""CI only: prepare a local moto S3 server WITH signature checks, for the S3 object store tests.

moto must be started with INITIAL_NO_AUTH_ACTION_COUNT=3: the three IAM calls below (user, policy,
access key) are the only unauthenticated ones; every later request, the bucket creation included,
must carry a valid Signature Version 4 from that key, or moto answers 403 SignatureDoesNotMatch.
Wait for moto with a TCP connection only: an HTTP probe would count as one of the three calls.
The throwaway key is printed as QA_TEST_S3_* lines for $GITHUB_ENV; it only exists inside this CI job.
"""

import json
import sys

import boto3

endpoint = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:4570"
bootstrap = dict(
    endpoint_url=endpoint,
    region_name="us-east-1",
    aws_access_key_id="bootstrap",
    aws_secret_access_key="bootstrap",
)
iam = boto3.client("iam", **bootstrap)
iam.create_user(UserName="qa-ci")
iam.put_user_policy(
    UserName="qa-ci",
    PolicyName="s3",
    PolicyDocument=json.dumps(
        {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:*", "Resource": "*"}]}
    ),
)
key = iam.create_access_key(UserName="qa-ci")["AccessKey"]
boto3.client(
    "s3",
    endpoint_url=endpoint,
    region_name="us-east-1",
    aws_access_key_id=key["AccessKeyId"],
    aws_secret_access_key=key["SecretAccessKey"],
).create_bucket(Bucket="qa-ci-bucket")
print(f"QA_TEST_S3_ENDPOINT={endpoint}")
print("QA_TEST_S3_BUCKET=qa-ci-bucket")
print("QA_TEST_S3_REGION=us-east-1")
print(f"QA_TEST_S3_ACCESS_KEY_ID={key['AccessKeyId']}")
print(f"QA_TEST_S3_SECRET_ACCESS_KEY={key['SecretAccessKey']}")
