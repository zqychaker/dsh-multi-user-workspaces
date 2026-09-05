# 与 dsh-remote 的结合:每用户远程工作区

[English](remote-workspaces-integration.md)

## dsh-remote 已经提供了什么

[dsh-remote](https://github.com/flymysql/dsh-remote)(v0.8.x,npm `dsh-remote`)是一个远程工作助手插件:设置页里的多机器 SSH 注册表、双标签工作区选择器(本机/远程)、以及 21 个 `rw_*` 模型工具。确认一个远程选择后,它会在 `$DSH_HOME/remote-workspaces/<host>-<user>-<port>/<base>` 下创建**真实的本地镜像**并通过 `fs.realpath`,于是 harness 把它当作普通工作区接管——`dsh-workspace` 与 harness 核心零改动。

## 目标场景

一个中心 `dsh web` 部署(家庭服务器,经 Tailscale/nginx 访问)。多个用户从**各自的电脑**以本人身份登录(见[多用户 note](2026-09-05-multi-user-private-shared-workspaces.zh.md))。每个用户把自己的电脑注册为 SSH 机器,创建一个**位于自己电脑上的远程工作区**,agent 通过镜像与 `rw_*` 工具在那里工作。默认私有:用户 A 的电脑及其工作区对用户 B 不可见。

## 差距:dsh-remote 是 home 全局的,不是按用户的

1. **机器注册表是一份全局列表。** 已保存机器、"当前机器"、SSH 凭据(密码/密钥记录)被部署上的所有浏览器共享。→ 按 `userId` 限定注册表(note §1 的 `ctx.users`):每用户机器行、每用户凭据。共享服务器上 OS keychain 无法区分登录用户,所以每用户文件化凭据记录是那里的默认。
2. **镜像根目录是全局的。** 两个用户镜像同一台 host 时 `$DSH_HOME/remote-workspaces/<host>-...` 会冲突;更尖锐的是,用户 A 的私有项目文件会被用户 B 的 agent 在服务器上读到。→ 每用户镜像根 `$DSH_HOME/remote-workspaces/<userId>/<host>-...`。
3. **工作区没有可见性。** 远程镜像被当作普通工作区接管。→ 通过 actor 限定的 `create` 以 `visibility: 'private'` 接管(note §3),用户自己的远程工作区只出现在其侧边栏。位于 owner 暴露的机器上(比如中心服务器本身)的工作区可标记为 `shared`。
4. **选择器是全局的。** 设置 → 远程工作区的机器列表与选择器远程标签显示所有已保存机器。→ 按登录用户过滤(note §2 之后,选择器所在的浏览器会话已携带 actor)。
5. **`rw_*` 工具无需新东西。** 它们本来就是 session 作用域的;操作用户随 note §2 的会话带入,所以用户会话只能 `rw_connect` 自己注册表行上的机器。

## 项目形态

一个结合插件项目,分两层交付:

- **核心层** — [多用户 note](2026-09-05-multi-user-private-shared-workspaces.zh.md)的四块:用户注册表、携带身份的浏览器会话、工作区所有权/可见性、actor 限定的 GUI。
- **远程层** — `dsh-remote` 的用户作用域扩展:挂载时消费 `ctx.users`(不存在时回退到单一隐式 owner),按操作用户限定机器注册表、镜像根与选择器。若维护者接受,作为可选 seam 上游到 `dsh-remote`;否则在本项目内捆绑 fork。

## 验收标准(相对多用户 note 的增量)

1. 用户 A 在笔记本 A 上把笔记本 A 注册为机器并在其上创建远程工作区;agent 通过镜像在 A 上编辑文件。
2. 用户 B 看不到 A 的任何机器或远程工作区;B `rw_connect` A 的 host 时失败为 B 注册表中未知。
3. 中心服务器上的共享工作区对双方可见;其中会话对双方可见(多用户 note §4)。
4. 删除用户 A 会移除 A 的机器行、凭据与镜像,不影响 B 的。
