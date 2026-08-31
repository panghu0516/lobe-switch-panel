#!/bin/bash
# 流式版：pg_dump -Fc | mc pipe 直传 S3，全程不落盘。
# 背景：库涨到 470MB 后，落盘版在「写 /tmp 超 ephemeral 100Mi 限额」时被 kubelet 驱逐（Evicted），
#   Job 重试同样撞墙 → DeadlineExceeded → 备份必死。流式管道让 100Mi 限制彻底无关。
# -Fc 压缩在内存流式完成；mc pipe 分片直传。pipefail 保证 pg_dump 断流显式失败退出，不吞错。
# 内存峰值 < 30MiB。归档 bucket/<YYYY-MM>/<前缀>-<ts>-<db>.pgdump。env 沿用原约定。
set -e
set -o pipefail
get_date () { date +[%Y-%m-%d\ %H:%M:%S]; }
: ${MAINTENANCE_DB:='postgres'}
: ${COMPRESS_LEVEL:='6'}
START_DATE=$(date +%Y-%m-%d_%H-%M-%S)
YEAR_MONTH=$(date +%Y-%m)
NAME_PREFIX="${S3_NAME:-backup}"
echo "$(get_date) Postgres backup started (format=custom, compress=${COMPRESS_LEVEL}, stream-mode, archive=${YEAR_MONTH}/)"
export MC_HOST_backup=$S3_URI
mc mb "backup/${S3_BUCK}" --insecure || true
dump_db(){
  DATABASE=$1
  psql "${PG_URI%/}/${DATABASE}" -c ''
  REMOTE_OBJ="backup/${S3_BUCK}/${YEAR_MONTH}/${NAME_PREFIX}-${START_DATE}-${DATABASE}.pgdump"
  echo "$(get_date) [stream] pg_dump -Fc | mc pipe -> ${REMOTE_OBJ}"
  pg_dump --format=custom --compress="${COMPRESS_LEVEL}" "${PG_URI%/}/${DATABASE}" | mc pipe "${REMOTE_OBJ}" --insecure
  echo "$(get_date) [stream] done"
  echo "$(get_date) Backup complete: ${DATABASE}"
}
DB_NAME=${PG_URI##*/}
if [[ $DB_NAME == *"@"* ]]; then DB_NAME=""; fi
if [ -z "$DB_NAME" ]; then
  echo "$(get_date) No database selected. Running backup for all databases:"
  DB_LIST=$(psql "${PG_URI%/}/${MAINTENANCE_DB}" -A -c "SELECT datname FROM pg_database WHERE datname NOT LIKE 'template%';" | head -n -1 | tail -n +2)
  for db in $DB_LIST; do dump_db "$db"; done
else
  PG_URI=${PG_URI%$DB_NAME}
  dump_db "$DB_NAME"
fi
echo "$(get_date) Postgres backup completed successfully"
