# 评价分区与公开查件服务

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

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
