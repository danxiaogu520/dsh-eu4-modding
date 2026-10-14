# ParadoxCode 服务端修复

补丁基准：`eae304594f5c987fa9723d12f46854e2861449ca`。这是版本号仍为 0.5.2 的开发提交，和公开 v0.5.2 标签不同。CI 按完整提交号获取源码，避免补丁随上游移动失效。

补丁保留源码的开发版本号，正式版本由上游发布流程决定。开发验证使用新建缓存；分析语义发生变化后，请重新构建 Vanilla / 依赖索引并清理开发测试使用的语法缓存，避免沿用旧结果。

修复内容：隐藏事件 option 条件要求；原规则、本地化、符号搜索及引用接口的 offset/revision 分页；引用的精确 range；根身份、扫描作用域及有界问题/排除明细。空的合法源文件仍参与索引；排除和读取失败分别报告。

转码统一处理完整文件，包括注释、标识符和字符串；引号限定实现及参数已删除。已有合法转义序列会保留，损坏序列和无法编码的字符拒绝整次转换。服务端声明 `pdcWholeFileTranscode`，供客户端确认能力。

官方分析修复 PR：[ParadoxCode #160](https://github.com/danxiaogu520/ParadoxCode/pull/160)。全文转码 PR：[ParadoxCode #161](https://github.com/danxiaogu520/ParadoxCode/pull/161)。

在干净源码副本上应用：

```bash
git checkout --detach eae304594f5c987fa9723d12f46854e2861449ca
git apply /path/to/dsh-eu4-modding/patches/paradoxcode-fixes.patch
cargo test --locked -p ide -p pdc --lib
cargo build --locked --release -p pdc --bin paradoxcode
```

把插件的 serverPath 指向生成的程序，即可启用全部服务端增强。客户端仍兼容官方 0.5.2，可通过已有 editorSearch 接口分页；正式新服务器发布前，默认自动下载不会取得这个本地修复版。

原源码版权和 MIT 许可见 [ParadoxCode LICENSE](https://github.com/danxiaogu520/ParadoxCode/blob/main/LICENSE)。
