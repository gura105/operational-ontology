[English](../README.md) | [日本語](./README.ja.md) | **简体中文**

# Operational Ontology

[![CI](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml/badge.svg)](https://github.com/gura105/operational-ontology/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

> **Operational Ontology（可操作的本体）是建立在其他系统数据之上的共享领域模型：通过对象和链接读取业务，通过动作（Action）执行业务规则、审计操作尝试，并将变更写回权威记录系统（system of record）。**
>
> 语义层让你能够*读取*业务。Operational Ontology 让你能够*运行业务*。

<img src="./assets/hero-diagram.svg" alt="智能体、应用和人通过共享模型读取数据。写入经过带审计的动作入口，再写回拥有相应状态的权威记录系统。">

本仓库用一个小型 TypeScript 参考实现，让这个定义可以实际运行。该模式源自 Palantir Foundry 的 Ontology；本示例将其中的思想提取出来，方便你阅读、fork 和改造。它是学习资源，不是框架，也不是供项目依赖的 npm 包。

## 快速开始

需要 Node.js 24 或更高版本，以及 pnpm。

```sh
pnpm install
pnpm demo    # 物理数据 → 集成 → 索引 → 读取 → 写入 → 拒绝 → 写回
pnpm test    # 验证行为
```

演示沿用[配套文章（英文）](https://www.dataengineeringweekly.com/p/building-an-operational-ontology)中的场景：一家公司收购了竞争对手，接手了**两套数据结构和状态编码各不相同的旧订单系统**。通过 SQL 和少量映射逻辑，将它们的数据整合到同一个模型中。运行后可以看到：

- 通过链接遍历和聚合，回答跨两个系统的业务问题。
- `cancelOrder` 拒绝取消已发货订单，并将获准的取消操作写回原 ERP。
- `assignOrder` 和 `addOrderNote` 保存本体自身拥有的状态；重新索引时，源数据会刷新，而这些状态会保留。
- 审计日志记录动作尝试，包括已应用和被拒绝的尝试。

https://github.com/user-attachments/assets/02bb8ca0-a476-4e33-b0ea-25c46c6e9dda

## 为什么要定义 Operational Ontology？

要以一致的含义回答“这位客户有多少尚未发货的订单？”，就需要一个用业务术语读取数据的模型。当应用或 AI 智能体进一步取消订单时，还需要检查操作条件、记录这次尝试，并将变更送达拥有该记录的 ERP。本仓库的出发点，是将这些职责视为共享模型的一部分。

仅凭“语义层”和“本体”这两个词，无法判断它们涵盖了多少上述职责。比较相近概念各自建模的内容，以及它们如何处理业务操作，可以更清楚地看出区别。

| 概念或架构 | 主要建模的内容 | 与业务操作的关系 |
| --- | --- | --- |
| 语义层 | 指标、属性和聚合的含义 | 一致地回答数据问题。操作条件和写回机制需要另行设计。 |
| 形式本体 / 知识图谱 | 概念含义、实体及其关系 | 表达含义和关系。除了数据更新，还需要设计业务规则和审计机制。 |
| AI 上下文层 | 回答和决策所需的含义与背景 | 支持智能体理解信息。对其执行的操作进行管控，需要另行设计。 |
| CRUD API / API 封装 | 数据访问或单项操作 | 在何处落实规则、审计和写回，取决于各 API 的设计。 |
| **Operational Ontology** | **共享对象和链接，以及承载业务规则的动作** | **将操作条件、审计以及向权威数据源写回纳入共享模型的契约。** |

这些技术可以组合使用。我们希望命名的是这样一种架构：**所有使用方都通过同一个模型，在相同的业务规则下改变状态**。我们从 Foundry 的 Ontology 中提取这种架构，并通过下面四个特性将其定义为 Operational Ontology，以便在不依赖特定产品的前提下讨论和实现它。

## 四个特性

本仓库将同时具备以下四个特性的系统称为 Operational Ontology。这些特性描述的是模式；存储引擎、集成工具和一致性机制由具体实现选择。

1. **具有业务语义的对象和链接。** 在其他系统拥有的既有数据之上，显式地建模业务实体及其关系。
2. **统一经由动作写入。** 业务决策只能通过具名动作改变状态。所有使用方都使用同一套 API。对源数据重新索引是独立的基础设施操作。
3. **在动作中落实业务规则。** 通过前置条件检查领域不变量，例如“已发货的订单不能取消”。违反规则时返回机器可读的拒绝结果，已应用和被拒绝的尝试都会被审计。前置条件表达业务有效性；访问策略决定谁可以操作。
4. **写回权威记录系统。** 每项状态都声明其所有者，对源系统拥有的状态所做的变更，通过受管控的副作用传回其所有者。该模式包含对源系统所拥有状态的实际写入。

示例中的状态所有权分为三类：

- **source-backed（源系统所有）：** ERP 拥有 `Order.status`；取消订单时会写回 ERP。
- **ontology-owned（本体所有）：** 本体拥有负责人和备注，源系统中没有对应的列。
- **derived（派生）：** 汇总值和计数在查询时计算，不进行写入。

<img src="./assets/authority-map.svg" alt="Order 对象的状态归属图（authority map）。status 和 total 由上游订单系统拥有，属于 source-backed，通过受管控的路径写回。assignee 和 Note 属于 ontology-owned，本体的数据存储是它们的唯一权威来源。聚合值和计数属于 derived，只计算，不写入。不允许存在未声明所有者的状态。">

## 从代码看模式

模型是一个普通的值，包含对象类型、链接类型和动作类型。这三类定义在运行时都有对应的实例。

| 定义（类型） | 运行时实例 |
| --- | --- |
| 对象类型：`Order` | 某个订单及其属性 |
| 链接类型：`customerOrders` | 某个客户与某个订单之间的连接 |
| 动作类型：`cancelOrder` | 尝试取消某个订单的一次调用 |

编辑（edits）描述动作拟对对象和链接进行的变更。审计日志记录动作的执行尝试及其结果，包括应用和拒绝。定义保存在代码中；实例状态和执行记录保存在存储中。

模型还可以定义只读的 **Function（函数）**，用于回答“查找符合某项任务要求的设备”等业务问题。使用方无需自行实现查询条件，就能得到基于共享业务规则的结果。

将模型表示为数据而非类，是为了能够枚举描述操作所需的信息。仅有 `class Order { cancel() {} }` 中的方法签名，无法获取参数校验规则或前置条件。本实现将这些信息保留在定义值中，让应用可以共享模型、在运行时检查模型，并从中生成 MCP 工具。

以下片段将取消规则与动作参数及其描述的编辑放在一起。import 和完整模型见 [`examples/orders/ontology.ts`](../examples/orders/ontology.ts)。

```ts
const objects = {
  Customer: defineObject({
    primaryKey: 'id',
    properties: { id: z.string(), name: z.string(), region: z.string() },
  }),
  Order: defineObject({
    primaryKey: 'id',
    properties: {
      id: z.string(),
      status: z.enum(['pending', 'shipped', 'cancelled']),
      total: z.number().int(), // 以最小货币单位计价，不用浮点数表示金额
      assignee: z.string().nullable(),
    },
    owned: { assignee: null },                       // 声明本体自身拥有的状态
    source: 'north.tbl_order ∪ south.SALES_ORDER',   // 物理数据先于模型存在
  }),
}

const ontology = defineOntology({
  name: 'orders',
  objects,
  links: {
    customerOrders: defineLink({ from: 'Customer', to: 'Order', kind: 'one-to-many' }),
  },
  actions: {
    cancelOrder: defineAction(objects, {
      object: 'Order',
      targetParam: 'orderId',
      params: { orderId: z.string(), reason: z.string().min(1) },
      preconditions: [
        ({ object }) => object.properties.status === 'shipped'
          ? reject('SHIPPED_ORDER_CANNOT_BE_CANCELLED', `order ${object.pk} has already shipped`)
          : undefined,
      ],
      effects: ({ object }) => [modify(object, { status: 'cancelled' })],
      writeback: true,
    }),
  },
})
```

调用 `execute('cancelOrder', …)` 时，会加载目标对象并检查规则。对于获准的写入，运行时会校验编辑计划，将变更写回源系统，然后提交本地编辑和审计条目。effects 函数只描述变更；外部写入由适配器执行。

<img src="./assets/action-gate.svg" alt="所有调用方，无论是人还是 AI 智能体，都通过同一个受管控的入口调用具名动作 cancelOrder。前置条件以机器可读的错误拒绝已发货订单；获准的调用会改变订单状态。每次尝试，无论应用还是拒绝，都会记入审计日志。设计中不提供通用 UPDATE 路径。">

## 应用示例：数据驱动的业务运营

产品召回、设备异常、患者入院请求、交易告警。业务团队需要汇集信息，判断要对谁或什么采取行动、依据是什么，并随着情况变化反复决策和执行。我们将这一工作流程称为**数据驱动的业务运营**。

订单演示（`pnpm demo`）展示 Operational Ontology 的基本结构：用共享模型处理多个系统的数据，并结合业务规则、写回、数据归属和审计。

建议接着阅读召回示例。它在同一个订单模型上加入客服系统，从已发货订单中找出相关客户，与现有工单比对后创建缺少的工单。订单由 ERP 管理，工单由客服系统管理，示例将探索与业务操作串成完整流程。

工厂、医院和金融示例进一步展示影响范围追踪、候选资源评估与分配，以及通过集合和聚合开展调查。

| 示例 | 展示的业务流程 | 运行 |
| --- | --- | --- |
| [召回（英文）](../examples/recall/README.md) | 跨越 ERP 和客服系统，从找出受影响客户到创建更换联系工单。 | `pnpm demo:recall` |
| [工厂（英文）](../examples/factory/README.md) | 沿生产和出货关系确定影响范围，记录应对任务及其证据。 | `pnpm demo:factory` |
| [医院（英文）](../examples/hospital/README.md) | 评估病床和护士候选，复核选定组合的条件，记录临时分配。 | `pnpm demo:hospital` |
| [金融（英文）](../examples/finance/README.md) | 调查账户间的共同收款方及相关转账，记录调查案件及其证据。 | `pnpm demo:finance` |

这些示例使用虚构数据，将集合探索与模型中的领域规则结合起来。找到候选对象或共同关系，本身并不意味着决策已经确定，也不会改变业务状态。

## 面向 AI 智能体（MCP）

```sh
pnpm mcp     # 通过 stdio 提供同一个本体
```

服务器从模型中生成 `search_order`、`traverse_customer_orders`、`cancel_order` 和 `read_audit_log` 等工具。智能体尝试取消已发货订单时，会与人类调用方一样收到 `SHIPPED_ORDER_CANNOT_BE_CANCELLED`。业务规则存在于模型中，因此无需依靠提示词强制执行规则。

仓库的 [MCP 配置](../.mcp.json)连接订单示例。智能体在自己的代码执行环境中筛选返回的数据。[实现说明（英文）](./IMPLEMENTATION.md#mcp-query-inputs)介绍了这一流程和工具输入；[调用方身份（英文）](./IMPLEMENTATION.md#visibility-and-caller-identity)另有说明。

https://github.com/user-attachments/assets/28327062-e09f-4103-943e-434a0e55b327

## 如何阅读代码

从前三个文件入手，再通过其余文件了解演示中的具体部分。

| 文件 | 关注内容 |
| --- | --- |
| [`examples/orders/ontology.ts`](../examples/orders/ontology.ts) | 业务模型：对象、关系、所有权和动作规则。 |
| [`examples/orders/demo.ts`](../examples/orders/demo.ts) | 从调用方视角观察读取、写入成功、拒绝和重新索引。 |
| [`src/core.ts`](../src/core.ts) | 模型定义及其运行时：沿 `execute()` 查看校验、写回，以及编辑和审计的提交过程。 |
| [`src/query.ts`](../src/query.ts) | 已求值的集合、筛选、集合运算和聚合。 |
| [`examples/orders/integrate.ts`](../examples/orders/integrate.ts) | 如何将两套旧系统的数据结构转换为一份快照。 |
| [`examples/orders/erp-adapter.ts`](../examples/orders/erp-adapter.ts) | 如何将已受理的变更送达源系统，包括拒绝基于过时状态的取消操作。 |
| [`src/mcp.ts`](../src/mcp.ts) | 如何将同一个模型转换为智能体可用的工具。 |

[`tests/`](../tests/) 以可执行的形式表达公共契约的行为和类型预期；场景测试则放在各示例目录中的 `scenario.test.ts`。`pnpm test` 会运行两类测试。[实现说明（英文）](./IMPLEMENTATION.md)介绍 API 细节、处理顺序和边界情况。

## 实现范围与行为声明

本仓库实现的是中间层。周边应用和数据集成由演示提供。

源系统中不存在的状态，例如负责人和备注，以及动作尝试的记录，需要保存在这一层。因此，除了索引后的源数据快照，本实现还拥有自己的存储，用于保存动作编辑和审计日志。

<img src="./assets/where-this-sits.svg" alt="应用、Operational Ontology 和数据层这三个层次，分别对应 Foundry 和本仓库中的实现。本仓库实现中间层，并拥有自己的存储。本体与数据层之间有两个契约：集成后的物理数据由外部提供，写回是受管控的副作用。">

实现需要声明调用方能够观察到的行为选择。本实现作出以下选择，也可以通过 `Runtime.declarations` 查看：

| 事项 | 本实现的声明 |
| --- | --- |
| 所有权 | 通过 `owned` 和 `writeback` 声明，并对照每个编辑计划进行检查。 |
| 写回失败 | 先执行写回。如果源系统拒绝，则不提交本地编辑。如果源系统写入成功而本地提交失败，系统间状态会出现分歧，需要核对并修复。 |
| 重新索引 | 刷新源系统拥有的状态，保留本体拥有的状态。如果加载会使本体拥有的编辑失去关联对象，则拒绝加载。 |
| 可见性 | 没有策略的对象对所有人可见。actor 由调用方自行声明；没有身份认证。审计读取是未经可见性筛选的管理视图。 |

运行时通过同步动作执行和 SQLite 展示该模式。它不包含 UI 构建器、流水线框架、可扩展的索引服务或通用授权系统。写入入口是调用方进程内的 API 契约。这样的范围使实现保持易读。

Action 使用执行前指定的 ID，可以创建本体拥有的对象，也可以通过写回创建源系统拥有的记录。不支持删除、链接属性和复合主键。[实现说明（英文）](./IMPLEMENTATION.md#current-limits)记录了其余限制和 API 细节。已发布版本见 [release notes（英文）](https://github.com/gura105/operational-ontology/releases)。

## 常见问题

**这不就是带校验的 CRUD 吗？**

组成部分很常见，组织方式却不同。典型的 CRUD 校验位于单个应用内部，作用于该应用拥有的表。这里的模型建立在其他系统拥有的数据之上，由所有使用方（UI、脚本、智能体）共享，将所有业务写入统一经由动作执行，审计动作尝试，并将受理的变更写回权威记录系统。最接近的既有描述是：从应用中提取出来、建立在其他系统数据之上的 CQRS 命令层。

**知识图谱不也能写入吗？**

可以，也支持条件更新。它同样拥有模式和实例。Operational Ontology 进一步纳入动作类型（业务操作定义）及其实例（单次执行尝试），将具名业务操作、机器可读的拒绝结果、操作尝试的审计轨迹，以及向权威记录系统写回，一并纳入模型。区别不在于能力——这些都可以构建在三元组存储之上——而在于模型将什么定义为一等要素，并对其统一管控。

**为什么用 TypeScript 而不是 YAML 定义？**

因为业务规则就是代码，而嵌入 YAML 的规则表达式语言往往会逐渐变成临时拼凑的规则引擎。TypeScript 对象字面量既能让模型保持可枚举，又能让规则使用普通的带类型代码。结构用数据表示，规则用函数表达。

## 相关工作

- **Palantir Foundry Ontology：** 该模式的来源；参见其[语义与动态模型（semantic/kinetic，英文）](https://www.palantir.com/docs/foundry/ontology/overview)、[动作类型（英文）](https://www.palantir.com/docs/foundry/action-types/overview)和[写回 webhooks（英文）](https://www.palantir.com/docs/foundry/action-types/webhooks)。
- **DDD、CQRS 和事件溯源：** 与实体、命令、带条件检查的变更和日志相关的思想。在本实现中，领域模型由多个使用方共享，并建立在其他系统的数据之上。
- **该术语的既有用法：** Vladimir Kozlov 的[定义文章（英文）](https://www.linkedin.com/pulse/operational-ontology-semantic-interface-between-data-action-kozlov-njnle)和 [Foundry 入门（英文）](https://www.linkedin.com/pulse/understanding-palantirs-operational-ontology-beginners-kozlov-d0vse)，以及 FSTech 的 [Operational Ontology Framework（英文）](https://github.com/fstech-digital/operational-ontology-framework)。本仓库通过上述四个特性和可运行示例说明自己对这一术语的定义。

## 作者

作者与维护者：[gura105](https://github.com/gura105)（[X](https://x.com/gura105)）。欢迎在 [Discussions](https://github.com/gura105/operational-ontology/discussions) 中提出问题和反例。

MIT © gura105
