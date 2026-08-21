#!/bin/bash
# 收敛版：pg_dump -Fc 落盘 /tmp + mc cp 传本地文件。彻底绕开 mc pipe 流式 hang。
# -Fc 落盘为压缩后 ~53MiB < 100Mi ephemeral；mc cp 传已知大小文件，断流显式失败退出(set -e)，不 hang。
# 内存峰值 < 30MiB < 128Mi。归档 bucket/<YYYY-MM>/<前缀>-<ts>-<db>.pgdump。env 沿用原约定。
set -e
set -o pipefail
get_date () { date +[%Y-%m-%d\ %H:%M:%S]; }
: ${MAINTENANCE_DB:='postgres'}
: ${COMPRESS_LEVEL:='6'}
START_DATE=$(date +%Y-%m-%d_%H-%M-%S)
YEAR_MONTH=$(date +%Y-%m)
NAME_PREFIX="${S3_NAME:-backup}"
echo "$(get_date) Postgres backup started (format=custom, compress=${COMPRESS_LEVEL}, file-mode, archive=${YEAR_MONTH}/)"
export MC_HOST_backup=$S3_URI
mc mb "backup/${S3_BUCK}" --insecure || true
dump_db(){
  DATABASE=$1
  psql "${PG_URI%/}/${DATABASE}" -c ''
  TMPFILE="/tmp/pgbackup-${DATABASE}-${START_DATE}.pgdump"
  REMOTE_OBJ="backup/${S3_BUCK}/${YEAR_MONTH}/${NAME_PREFIX}-${START_DATE}-${DATABASE}.pgdump"
  echo "$(get_date) [1/2] pg_dump -Fc -f ${TMPFILE}"
  pg_dump --format=custom --compress="${COMPRESS_LEVEL}" "${PG_URI%/}/${DATABASE}" -f "${TMPFILE}"
  echo "$(get_date) [1/2] done, size=$(wc -c < "${TMPFILE}") bytes"
  echo "$(get_date) [2/2] mc cp -> ${REMOTE_OBJ}"
  mc cp "${TMPFILE}" "${REMOTE_OBJ}" --insecure
  echo "$(get_date) [2/2] upload done"
  rm -f "${TMPFILE}"
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
