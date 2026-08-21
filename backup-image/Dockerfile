# PG17 兼容的 postgres 备份镜像
#
# 背景：升库到 PG17（如 paradedb:0.24.3-pg17）后，backuptools/postgres-backup-s3 的
#   定时备份失败。失败有两种都能自圆其说的病因，本镜像对二者都不依赖判断、同时覆盖：
#   (H1) 旧镜像内置 pg_dump < 17，在 PG17 系统表/扩展对象上卡死 → 用 FROM postgres:17 使 pg_dump==17 根治；
#   (H2) 与 pg_dump 无关，新版镜像的 mc 与对象存储 endpoint 不兼容，mc pipe 上传 hang，
#        管道 pg_dump|压缩|mc pipe 背压，使 dump 看着龟速后归零、最终 BackoffLimitExceeded
#        → mc 改借曾在 2026-07-21 成功备份过的 475d9bf 镜像（其 mc 已被现场验证可上传），
#          不借嫌疑最大的 latest/fb2bc35 的 mc。
# 备份脚本 backup.sh 与 backuptools 的 entrypoint.sh 等价，保留 export MC_HOST_backup=$S3_URI 约定，
#   故 Sealos 侧 S3_URI/S3_BUCK/PG_URI 无需改动。

FROM backuptools/postgres-backup-s3:475d9bf AS mcsrc
# 475d9bf 的 mc 安装路径可能是 /usr/local/bin/mc 或 /usr/bin/mc，多路径兜底，钉死来源不依赖 PATH 解析。
RUN cp /usr/local/bin/mc /mc-bin 2>/dev/null \
 || cp /usr/bin/mc /mc-bin 2>/dev/null \
 || { echo "FATAL: mc binary not found in mcsrc image" >&2; exit 1; }

FROM postgres:17

RUN apt-get update \
 && apt-get install -y --no-install-recommends pigz ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*

COPY --from=mcsrc /mc-bin /usr/local/bin/mc
RUN chmod +x /usr/local/bin/mc

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
