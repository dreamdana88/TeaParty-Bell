# TeaParty-Bell systemd 部署指南

## 模板文件

- `teaparty-bell.service.example` — User Service 模板

## 部署步骤（VPS）

```bash
# 1. 确认项目路径
cd /home/YOUR_USER/TeaParty-Bell

# 2. 确认 Node.js 路径
which node

# 3. 编辑 service 文件
cp deploy/systemd/teaparty-bell.service.example ~/.config/systemd/user/teaparty-bell.service
nano ~/.config/systemd/user/teaparty-bell.service
```

修改以下字段：
- `WorkingDirectory` — 项目实际路径
- `ExecStart` — Node.js 实际路径（`which node`）
- `.env` 中的敏感信息**不要**写入 service 文件

```bash
# 4. 重新加载并启动
systemctl --user daemon-reload
systemctl --user restart teaparty-bell
systemctl --user status teaparty-bell
```

## 自动重启行为

| 退出码 | 含义 | systemd 行为 |
|--------|------|-------------|
| 0 | 正常退出 (SIGTERM/SIGINT) | 不重启 |
| 1 | 运行期 Gateway 故障 | 10 秒后重启 |
| 78 | 永久性配置/权限故障 | **不重启**（防止无限循环） |

## 日志查看

```bash
# 最近 200 行
journalctl --user -u teaparty-bell -n 200 --no-pager

# 实时跟踪
journalctl --user -u teaparty-bell -f

# 只看 error
journalctl --user -u teaparty-bell -p err --no-pager
```

## 手动停止与启动

```bash
systemctl --user stop teaparty-bell
systemctl --user start teaparty-bell
```

## 常见问题

**systemd 报 RestartPreventExitStatus 不支持？**

需要 systemd ≥ 231。检查版本：
```bash
systemctl --version
```

如版本过低，移除 `RestartPreventExitStatus=78`，改用其他方式防止重启风暴。

**服务启动后立即退出？**

检查：
1. `.env` 是否存在且配置正确
2. `NODE_ENV=production` 是否设置
3. `TEST_MODE` 是否为 `false`
4. `journalctl --user -u teaparty-bell -n 50` 查看启动日志
5. `node src/index.js` 手动启动排查
