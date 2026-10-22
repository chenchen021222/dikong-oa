#!/bin/bash
# 在服务器上以 root 执行：安装依赖、确保数据库账号存在，并重启服务。
set -euo pipefail

install -m 644 /opt/dikong-oa/deploy/nginx-dikong.conf /etc/nginx/sites-available/dikong-oa
ln -sfn /etc/nginx/sites-available/dikong-oa /etc/nginx/sites-enabled/dikong-oa
rm -f /etc/nginx/sites-enabled/default
install -m 644 /opt/dikong-oa/deploy/dikong-oa.service /etc/systemd/system/dikong-oa.service
systemctl daemon-reload
systemctl enable dikong-oa

if [[ ! -f /opt/dikong-oa/mysql.json ]]; then
  PW="$(openssl rand -hex 18)"
  umask 077
  cat > /opt/dikong-oa/mysql.json <<EOF
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "dikong",
  "password": "${PW}",
  "database": "dikong_oa"
}
EOF
  mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS dikong_oa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'dikong'@'localhost' IDENTIFIED BY '${PW}';
ALTER USER 'dikong'@'localhost' IDENTIFIED BY '${PW}';
GRANT ALL PRIVILEGES ON dikong_oa.* TO 'dikong'@'localhost';
FLUSH PRIVILEGES;
SQL
fi

cd /opt/dikong-oa/server
npm install --omit=dev
systemctl restart dikong-oa
nginx -t
systemctl reload nginx
echo "dikong-oa updated"
