#!/bin/sh
# Creates the WprGo archive bucket at ministack startup so the app-side
# "SDK, no auto-create" contract holds. Init scripts receive the AWS creds
# and endpoint env automatically; with S3_PERSIST=1 the bucket survives
# restarts, so this is a no-op on subsequent boots.
[ -n "$WPR_ARCHIVES_BUCKET" ] || exit 0

if aws s3api head-bucket --bucket "$WPR_ARCHIVES_BUCKET" >/dev/null 2>&1; then
  echo "ministack init: bucket $WPR_ARCHIVES_BUCKET already exists"
  exit 0
fi

if ! aws s3 mb "s3://$WPR_ARCHIVES_BUCKET"; then
  echo "ministack init: failed to create bucket $WPR_ARCHIVES_BUCKET" >&2
  exit 1
fi
