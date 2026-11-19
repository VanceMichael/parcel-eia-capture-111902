# 评价分区与公开查件服务

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 查件工具（lib/）

顾问工具在来源服务之上做分区判定，不修改任何来源数据。

- `node lib/cli.mjs consult --request requests/example.json [--release Z-18] [--order] [--out 结论.json]`
  新咨询：按拟开工日选有效发布（`--release` 可固定编号做历史复核），递归查齐分片后输出分区适用条目、限制面积、同层冲突、暂停状态与原件证据。加 `--order` 才会实际向档案室提交调件，否则只给调件建议。
- `node lib/cli.mjs poll --prior 结论.json [--order]`
  按结论中保存的原请求快照与原发布编号重跑判定，对账档案室新交付；固定发布不会因目录变化而漂移。
- `node lib/cli.mjs review --prior 旧结论.json --request 新请求.json`
  复核已签答复：同时按原发布编号与当前有效发布重查，逐段给出「立即暂停引用 / 等待补件 / 未受影响」，列出新纳入部分所需资料与可重发范围。

判定口径：

- 截断分片的 `records` 只是预览，必须沿 `subcells` 递归到完整网格；子网格取件失败会登记缺口并保留已取得部分，整体结论降为「无法确定」，已查实单元仍单独给出。
- 同 `unit`+`feature` 且几何一致的重复分片去重；几何不一致记为缺口。共线、角点接触单独列示，限制面积只统计实质交叠（并集去重）。
- 同一生效范围内同层级单元实质交叠按门户 `overlapPolicy` 标注冲突（并列待问询），不任选条目。
- 地块补充函按与项目范围的实质交叠适用；暂停条款按拟开工日判断（`fromDate`、`throughDate` 两端包含），只暂停 `pauseTarget` 指向的一项。
- 确定答复要求地图、条款与引用原件同属一次有效发布：公开目录无本次发布原件时标 `archiveRequired` 或 `wrongRelease`；档案室只认本次发布、本经办号的交付，旧调件号结果标 `stale` 且不得凑齐新版，`staged` 不冒充已交付。
- 复核时边界变化用正交格网差异量化新增/退出面积；新发布新增条目录入新需求；未受影响段落附当前发布的原件依据后才可重发。

## 来源接口

- `GET /registry/releases` 坐标是在本地项目平面格网中的米。validFrom 是业务生效日，tileKeys 枚举发布的查件网格。overlapPolicy 只约束同层。
- `GET /maps/cells?release=Z-17&cell=west` Z-18 的 west 网格返回截断，subcells 为可检索的子网格，所有多边形均闭合。边界可以共享，重复项的 unit 与 feature 相同。
- `GET /maps/cells?release=Z-17&cell=east` 东区。
- `GET /maps/cells?release=Z-18&cell=west` 截断时 records 只是预览，不能证明完整。
- `GET /maps/cells?release=Z-18&cell=west-south` 西区上、下片的边界共线。
- `GET /maps/cells?release=Z-18&cell=west-north` 西区北片与北区接边。
- `GET /maps/cells?release=Z-18&cell=east` 东区与北区局部重叠。
- `GET /maps/cells?release=Z-18&cell=north` 北区。
- `GET /registry/clauses?release=Z-17` level 为单元、地块或暂停。pauseTarget 指明受暂停的条目；原件按编号与发布查询。
- `GET /registry/clauses?release=Z-18` 新发布中的北区另行公开。fromDate、throughDate 两端均包含。
- `GET /registry/documents` 该接口列出当前可取得的发布原件。release 和 document 一起标识。
- `POST /archives/orders` 调件同时提交 requestKey、release、unit、use、documents。受理仅确认查件请求，已经归档的原件另查交付。
- `GET /archives/orders` 用 requestKey 查询调件请求是否受理。
- `GET /archives/fulfillment` 每页为档案室独立发布的调件交付，requestKey 对应提交的经办号。staged 表示待交付，delivered 带原件。
