# ParadoxCode 服务端修复

补丁基准：`eae304594f5c987fa9723d12f46854e2861449ca`。这是版本号仍为 0.5.2 的开发提交，和公开 v0.5.2 标签不同。CI 按完整提交号获取源码，避免补丁随上游移动失效。

补丁将本地语言服务器版本升级到 0.5.3，防止旧索引缓存沿用已改变的分析语义。它尚未代表上游正式发布。

修复内容：隐藏事件 option 条件要求；原规则、本地化、符号搜索及引用接口的 offset/revision 分页；引用的精确 range；根身份、扫描作用域及有界问题/排除明细。空的合法源文件仍参与索引；排除和读取失败分别报告。

在干净源码副本上应用：

```bash
git checkout --detach eae304594f5c987fa9723d12f46854e2861449ca
git apply /path/to/dsh-eu4-modding/patches/paradoxcode-0.5.3.patch
cargo test --locked -p ide -p pdc --lib
cargo build --locked --release -p pdc --bin paradoxcode
```

把插件的 serverPath 指向生成的程序，即可启用全部服务端增强。客户端仍兼容官方 0.5.2，可通过已有 editorSearch 接口分页；正式新服务器发布前，默认自动下载不会取得这个本地修复版。

原源码版权和 MIT 许可见 [ParadoxCode LICENSE](https://github.com/danxiaogu520/ParadoxCode/blob/main/LICENSE)。
