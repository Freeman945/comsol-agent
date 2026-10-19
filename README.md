# COMSOL 自动仿真助手（comsol-agent）

面向 DeepSeek Harness 的 COMSOL Multiphysics 自动化插件。它把自然语言仿真需求转换为可核查的结构化工具调用，并通过 COMSOL **官方 Java API** 在本机真实执行建模、求解、参数扫描与结果导出。

> 本文档描述的是当前已安装、已在本机测试的版本，不是开发提案。真实测试证据见 [TEST_REPORT.md](TEST_REPORT.md)。
>
> **第一次使用请先读 [中文使用手册](docs/使用手册.md)**：从环境检查、安装、第一次真实仿真，到参数扫描、结果解读和故障排查，按步骤教学。

---

## 1. 当前验收状态

| 项目 | 状态 |
|---|---|
| 插件安装 | 已通过 `plugin_manager install_bundle` 安装到当前 `desktop` profile |
| 工具注册 | 11 个工具已出现在当前会话的工具列表中 |
| COMSOL 检测 | 已检测到 `D:\COMSOL62\Multiphysics`，版本 `6.2.0.290` |
| 真实许可调用 | 已通过 Java API 创建模型并构建 3D 几何（许可检出成功） |
| 真实求解 | 已创建并求解 2D 轴对称同轴圆锥模型，网格 122 单元，`sol1` 生成 |
| S 参数 | `S11(2.45 GHz) = -0.002612 + 0.253224j`，`|S11| = 0.253238`，`-11.93 dB` |
| 参数扫描 | 4 组（2 频率 × 2 出口半径）全部成功 |
| 结果导出 | CSV、截线数据、PNG 场图均已生成并通过文件存在性检查 |
| 单元测试 | 9/9 通过 |
| 真实集成测试 | 1/1 通过（约 161 s） |
| 插件全链路自测 | 13/13 通过 |

**重要区分**：几何建模成功不代表物理模型正确；求解成功也不代表物理结论正确。当前模板只建立了一个明确标注的**空气/真空电磁基准模型**，不包含等离子体、气流或传热。

---

## 2. 架构

```
DeepSeek Harness (Windows 主机)
  └─ comsol-agent Host 插件（Node.js，运行在 Harness 主机进程）
       ├─ 工具层：参数校验、路径保护、任务编排、日志诊断
       ├─ 任务层：串行队列、超时、取消、断点续跑、job 持久化
       ├─ 驱动层：调用 COMSOL 自带 java.exe
       │    └─ ComsolBridge.java（独立 JVM，COMSOL Java API）
       │         ├─ 加载/保存 .mph
       │         ├─ 修改全局参数并回读核对
       │         ├─ 构建几何/材料/物理场/网格/研究
       │         ├─ 运行研究、读取解
       │         └─ 数值评估、CSV/PNG 导出
       └─ 可选：comsolbatch.exe（engine="batch"）

COMSOL Multiphysics 6.2（本机安装、本机许可）
```

- **没有远程服务、没有监听端口、没有网络上传**。插件直接运行在 Harness 主机进程中，通过 `child_process.spawn` 以参数数组启动本机 COMSOL Java 进程。
- 每次 COMSOL 调用是一个独立 JVM；默认最大并发 1，以避免同时占用多个许可席位。
- COMSOL Java API 使用 COMSOL 安装目录自带的 Java 11（`java\win64\jre`）与 `plugins\*` 类路径，无需额外 JDK。
- 插件首次使用时会用 COMSOL 自带 `javac` 编译 `java/ComsolBridge.java` 到工作区 `.driver\classes`。

### 工作区布局

默认工作区：`%USERPROFILE%\comsol-agent-workspace`（可通过配置修改）。

```
comsol-agent-workspace/
  .driver/            Java 桥接编译产物与编译日志
  jobs/<jobId>/       job.json、log.txt、result.json、sweep.json
  models/             新建模型
  runs/               运行输出与参数修改输出
  sweeps/<name>/      扫描输出 .mph
  exports/<name>/     CSV、PNG 等导出结果
```

---

## 3. 已验证环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 10.0.26200（x64） |
| COMSOL | `D:\COMSOL62\Multiphysics`，`COMSOL Multiphysics 6.2.0.290` |
| COMSOL 批处理 | `bin\win64\comsolbatch.exe` |
| COMSOL Java | `java\win64\jre`，`JAVA_VERSION="11.0.20"`，包含 `javac.exe` |
| COMSOL API jar | `plugins\com.comsol.api_1.0.0.jar` |
| 许可 | 本机 `license\license.dat` + `licenseinfo.ini`；真实 Java API 模型创建成功 |
| MATLAB | 检测到 `D:\matlab\2025a\bin\matlab.exe`；**未验证** MATLAB 许可或 LiveLink 授权 |
| LiveLink | `mli` 目录与 `com.comsol.mli_1.0.0.jar` 存在；状态为 `installed-unverified` |
| Harness | 本会话 Web GUI，插件已安装并启用 |

MATLAB/LiveLink 的“存在”只说明文件存在，不代表有可用许可。插件不会假设它们可用。

---

## 4. 安装与启用

### 4.1 当前已完成的安装

插件源码目录：

```
D:\comsol-agent
```

已通过 Harness 的正式机制安装：

```
plugin_manager(action="install_bundle", target="D:\\comsol-p\\comsol-agent")
```

返回 `application: "applied"`，插件行 `include:comsol-agent` 为 `active`。

### 4.2 修改代码后重新加载

本插件是 Host 插件。修改 `index.js`/`lib/*.js` 后，用插件管理器关闭再启用即可重新加载模块：

```
plugin_manager(action="set_plugin", target="include:comsol-agent", enabled=false)
plugin_manager(action="set_plugin", target="include:comsol-agent", enabled=true)
```

Java 驱动源码修改不需要重载插件：下次工具调用时根据源文件时间戳自动重新编译。

### 4.3 新机器安装

1. 确认 COMSOL 安装目录包含：
   - `bin\win64\comsolbatch.exe`
   - `java\win64\jre\bin\java.exe` 与 `javac.exe`
   - `plugins\com.comsol.api_*.jar`
2. 把 `comsol-agent` 目录放到本机任意位置。
3. 在 Harness 中执行：
   ```
   plugin_manager(action="install_bundle", target="<comsol-agent 的绝对路径>")
   ```
4. 若自动检测不到 COMSOL，按第 5 节设置 `comsolHome`。
5. 调用 `comsol_check_environment`，再用 `deep=true` 做一次真实许可探针。

无需 `pnpm install`。插件没有第三方 Node 依赖；Java 端使用 COMSOL 自带的 Jackson。

---

## 5. 配置

配置写在 bundle 行 `comsol-agent` 的 `config` 中（`cordis.patch.yml` 默认 `config: {}`）。所有字段可选。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `workspaceRoot` | `%USERPROFILE%\comsol-agent-workspace` | 工作区根目录；所有输出默认落在这里 |
| `comsolHome` | 自动探测 | COMSOL `Multiphysics` 目录，例如 `D:\COMSOL62\Multiphysics` |
| `allowedRoots` | `[workspaceRoot]` | 允许写出的额外根目录（绝对路径） |
| `maxConcurrentJobs` | `1` | 同时运行的 COMSOL 进程数；默认 1 保护共享许可 |
| `defaultTimeoutSec` | `600` | 默认 COMSOL 调用超时 |
| `sweepTimeoutSec` | `900` | 扫描单组默认超时 |
| `maxSweepCombinations` | `12` | 未显式 `confirm=true` 时允许的最大组合数 |
| `javaHeap` | `-Xmx2g` | COMSOL JVM 堆参数 |

也可用环境变量 `COMSOL_HOME`、`COMSOL_AGENT_WORKSPACE` 提供路径。

示例：

```yaml
- insert:
    - id: comsol-agent
      name: '@local/comsol-agent'
      config:
        comsolHome: 'D:\COMSOL62\Multiphysics'
        workspaceRoot: 'D:\comsol-agent-workspace'
        maxConcurrentJobs: 1
        maxSweepCombinations: 12
        javaHeap: '-Xmx4g'
```

---

## 6. 安全与文件保护

已实现：

- 所有输出路径必须在工作区或 `allowedRoots` 内；越界直接报 `OUTPUT_OUTSIDE_WORKSPACE`。
- 所有 COMSOL 进程使用**参数数组**启动，从不拼接 shell 命令字符串。
- 不执行由模型内容或自然语言拼接的任意命令。
- `comsol_set_parameters` 默认绝不覆盖输入 `.mph`，会拒绝 `outputPath == modelPath`。
- `comsol_run_model` 默认生成新的输出文件；拒绝覆盖输入。
- 新建模型默认不覆盖已有文件，除非显式 `overwrite=true`。
- 不删除用户已有文件；插件不做自动清理。
- 不修改系统环境变量、注册表、防火墙或 COMSOL 许可配置。
- 不上传模型、数据或日志到任何外部服务器。
- 默认串行调用 COMSOL，避免一次扫描占用多个许可席位。
- 扫描超过安全阈值时先返回 `confirmation_required` 和规模估算，不直接启动。

未实现/需要人工确认：

- 删除、覆盖已有用户文件（除显式 `overwrite=true` 的新建模型外）仍需用户自行确认。
- 大型扫描开始前建议用户确认估算；插件提供阈值和估算，但不会替用户判断机器负载。
- 不提供远程访问桥接，因此不存在公网监听端口。

---

## 7. 工具参考

所有工具名以 `comsol_` 开头。成功时返回结构化 JSON；失败时抛出带错误码的异常（例如 `[PARAM_NOT_FOUND] ...`），不会被当作成功。

### 7.1 `comsol_check_environment`

检测 COMSOL、Java API、批处理、许可线索、MATLAB/LiveLink。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `deep` | boolean | `false` | 为 `true` 时真实创建一个小模型/3D 几何以验证许可，可能短暂占用一个席位 |

返回重点字段：

```json
{
  "ok": true,
  "comsol": {
    "found": true,
    "home": "D:\\COMSOL62\\Multiphysics",
    "version": "6.2.0.290",
    "license": { "status": "checkout-verified-in-probe" }
  },
  "platform": { "workspaceRoot": "C:\\Users\\...\\comsol-agent-workspace" },
  "warnings": [],
  "unknowns": []
}
```

注意：不带 `deep` 时，`license.status` 是 `configured-but-unverified` 或 `unknown`，不会仅凭文件存在断言许可可用。

### 7.2 `comsol_validate_model`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelPath` | string | 必填 | `.mph` 绝对路径 |
| `workingDir` | string | 工作区 | 写权限检查目录 |
| `openCheck` | boolean | `true` | 是否让 COMSOL 实际加载模型 |
| `timeoutSec` | number | `180` | 加载检查超时 |

返回 `fileChecks`（文件层面）与 `modelOpen`（COMSOL 实际加载）**分开**的结果。对 COMSOL 案例库预览文件会返回：

```json
{
  "ok": false,
  "previewDetected": true,
  "modelOpen": { "ok": false, "error": { "code": "MODEL_IS_APPLICATION_LIBRARY_PREVIEW" } }
}
```

文件可读、扩展名正确、大小非零，都**不会**被当作模型有效。

### 7.3 `comsol_create_model`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `template` | enum | `coaxial_conical_gap` | `coaxial_conical_gap` 或 `rf_coax_air` |
| `name` | string | 自动 | 输出模型基名 |
| `outputPath` | string | `models/<name>.mph` | 工作区内绝对路径 |
| `templateParams` | object | 模板默认值 | 几何/频率/功率参数，见下表 |
| `meshSize` | number | `4` | COMSOL `hauto`，1 最细、9 最粗 |
| `solve` | boolean | `false` | 是否立即建网格并求解 |
| `overwrite` | boolean | `false` | 是否替换已有输出 |
| `timeoutSec` | number | `900` | 超时 |

模板参数（几何长度单位 mm，因模板几何 `lengthUnit=mm`）：

| 键 | 默认 | 含义 |
|---|---|---|
| `r_in` | `4.35` | 内导体半径 |
| `r_out` | `10` | 外导体半径 |
| `z_feed` | `20` | 同轴馈电段长度 |
| `z_tip` | `60` | 圆锥出口高度 |
| `r_tip_in` | `0.5` | 内圆锥出口半径 |
| `r_tip_out` | `6` | 外圆锥出口内半径 |
| `freq` | `2.45[GHz]` | 频率 |
| `P_in` | `1[W]` | 端口输入功率 |

返回模型路径、文件大小、几何/物理场/研究/网格摘要、求解状态与 `S11`（若 `solve=true`），以及 `modelingAssumptions`。

示例：

```json
{
  "template": "coaxial_conical_gap",
  "name": "demo",
  "solve": true,
  "meshSize": 4,
  "templateParams": { "freq": "2.45[GHz]" }
}
```

### 7.4 `comsol_set_parameters`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelPath` | string | 必填 | 源模型，绝不修改 |
| `params` | object | 必填 | 参数名 → 表达式（字符串或数字） |
| `outputPath` | string | `runs/<name>__params_<ts>.mph` | 新模型路径 |
| `allowNewParams` | boolean | `false` | 是否允许创建不存在的参数 |
| `timeoutSec` | number | `300` | 超时 |

流程：加载 → 校验参数存在 → 设置 → 保存 → 重新加载 → 逐一回读。返回 `paramsApplied` 和 `verification`，每项含 `readBack`、`matchesExactly`、`matchesNumerically`。参数不存在返回 `PARAM_NOT_FOUND` 并列出可用参数。

### 7.5 `comsol_run_model`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelPath` | string | 必填 | 源 `.mph` |
| `outputPath` | string | `runs/<name>__run_<ts>.mph` | 输出 `.mph` |
| `study` | string | 全部研究 | 研究标签，如 `std1` |
| `params` | object | — | 运行前修改的全局参数 |
| `solve` | boolean | `true` | 为 `false` 时只加载/改参数/保存 |
| `engine` | enum | `java` | `java`（完整文件访问）或 `batch`（comsolbatch） |
| `timeoutSec` | number | `900` | 超时 |
| `wait` | boolean | `false` | 为 `true` 时等待并返回最终状态 |

默认异步：立即返回 `jobId`，用 `comsol_get_job_status` 查询。`wait=true` 时返回最终状态；只有真正求解并生成非空 `.mph` 才返回 `ok=true`。

`engine="batch"` 使用：

```
comsolbatch -inputfile ... -outputfile ... -batchlog ... -study std1 -stoptime ...
```

批处理日志中的许可/内存/预览等致命问题会让任务标记失败。批处理输出文件名可能由 COMSOL 自动追加模型名，插件会扫描输出目录并返回 `actualOutputPath`。

### 7.6 `comsol_parameter_sweep`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelPath` | string | 必填 | 源模型 |
| `parameters` | object | 必填 | 参数 → 值数组；做笛卡尔积 |
| `study` | string | 全部研究 | 研究标签 |
| `outputDir` | string | `sweeps/<name>__<ts>` | 输出目录 |
| `confirm` | boolean | `false` | 超过阈值时必须为 `true` |
| `stopOnError` | boolean | `true` | 首个失败即停止 |
| `timeoutSec` | number | `900` | 每组超时 |
| `maxCombinations` | number | 配置值 | 本次安全阈值 |
| `resumeJobId` | string | — | 跳过该任务已成功的组合 |
| `wait` | boolean | `false` | 等待最终汇总 |

每组参数独立：加载 → 改参数 → 求解 → 保存 `<name>__<参数组合>.mph`。记录每组 `status`、`durationMs`、`outputPath`、`logPath`、`error`。状态持久化在 job 目录的 `sweep.json`，可断点续跑。

超过阈值时（未确认）返回：

```json
{
  "ok": false,
  "status": "confirmation_required",
  "combinations": 24,
  "threshold": 12,
  "estimate": { "worstCaseWallClockSec": 21600 }
}
```

> 实现说明：插件不使用 COMSOL 原生 Parametric 研究步，而是逐组独立运行。原因是逐组运行能提供每组独立日志、失败隔离、超时、取消和断点续跑，并且不会把一次大扫描绑在单个不可中断的求解进程里。这是对“优先原生扫描”的明确取舍，详见限制。

### 7.7 `comsol_get_job_status`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `jobId` | string | — | 省略时列出最近任务 |
| `limit` | number | `20` | 列表数量 |

返回 `jobId`、`kind`、`status`、`progress`、`durationMs`、`result`、`error`、`logPath`。状态包括 `queued/running/succeeded/failed/timeout/cancelled/interrupted`。

### 7.8 `comsol_read_log`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `jobId` | string | 必填 | 任务 id |
| `maxBytes` | number | `2 MiB` | 从日志末尾读取的最大字节 |

返回 `analysis`：`markers`、`categories`（每类含 `evidence`、`diagnosis`、`confidence`）、`conclusion`、`uncertainty`、`tail`。分类覆盖：案例库预览、许可、内存、网格、收敛、几何、材料/物理场、文件访问、桥接错误。

日志诊断是启发式的；工具会明确说明不确定性，不会仅凭一个词断言根因。

### 7.9 `comsol_export_results`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelPath` | string | 必填 | 已求解模型 |
| `outputDir` | string | `exports/<name>__<ts>` | 输出目录 |
| `sParameters` | boolean | `false` | 自动发现端口并导出 `Sij`、幅值、dB |
| `tableExpressions` | string[] | — | 全局表达式表 |
| `fieldImages` | array | — | `{expr, filename?, title?}` → PNG |
| `lines` | array | — | `{exprs, start, end, points?, filename?}` → CSV |
| `samples` | array | — | `{exprs, coordinates, filename?}` → CSV |
| `integrals` | array | — | `{exprs, evalKind, selection?, dataset?, filename?}` → CSV |

所有导出项都独立记录成功/失败；不会假设模型一定有端口或某个变量。返回 `items` 与 `fileChecks`（路径、存在、大小、行数）。只要有一项失败，任务状态为 `failed`，但其他已成功生成的文件仍会保留在返回结果中，不会被丢弃。

示例：

```json
{
  "modelPath": "C:\\...\\model.mph",
  "sParameters": true,
  "fieldImages": [{ "expr": "ewfd.normE", "filename": "E.png" }],
  "lines": [{ "exprs": ["ewfd.normE"], "start": [4.5, 10], "end": [9, 10], "points": 40 }]
}
```

### 7.10 `comsol_evaluate_results`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `modelPath` | string | 必填 | 已求解模型 |
| `expressions` | string[] | 必填 | 例如 `["ewfd.normE", "ewfd.S11"]` |
| `kind` | enum | `global` | `global/volume_integral/surface_integral/average/maximum/minimum/point/line` |
| `selection` | int[] 或 string | — | 几何实体编号或命名选择 |
| `dataset` | string | 第一个解数据集 | 数据集标签 |
| `coordinates` | number[][] | — | 点评估坐标；2D 轴对称用 `[r,z]` |
| `start`/`end` | number[] | — | 截线起止坐标 |
| `points` | number | `100` | 截线点数 |
| `uniformity` | boolean | `false` | 额外计算 `U = 1-(max-min)/(max+min)` |
| `timeoutSec` | number | `600` | 超时 |

返回每个表达式的 `real/imag`、`unit`、`featureType`、`nData`。`uniformity=true` 时返回公式、max/min/avg 和适用条件；该公式**不是** COMSOL 内建标准量。

2D 轴对称的积分语义已在实现中处理：

- 体积分：`IntSurface` + `intvolume=on`（对旋转体积分）
- 边界面分：`IntLine` + `intsurface=on`（对旋转面积分）
- 3D：`IntVolume` / `IntSurface`
- 点/截线：`Interp`

注意：`global` 只能评估全局标量（例如 `ewfd.S11`）；`ewfd.normE` 等场量必须使用 `volume_integral/average/maximum/minimum/point/line`。每个表达式会独立创建 COMSOL 评估特征；部分表达式失败时，成功值仍会返回，任务状态为 `failed`，失败项带 `hint` 说明正确的评估方式。

### 7.11 `comsol_cancel_job`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `jobId` | string | 必填 | 任务 id |
| `reason` | string | — | 取消原因 |

排队任务直接取消；运行中任务会终止其本机 COMSOL Java 进程。输出可能不完整，状态为 `cancelled`，不会被标记成功。

---

## 8. 典型工作流

以“同轴馈电圆锥微波结构”为例：

1. `comsol_check_environment`（必要时 `deep=true`）确认 COMSOL 与许可。
2. `comsol_create_model` 建立参数化 2D 轴对称基准模型，`solve=true` 先算一组。
3. `comsol_validate_model` 检查模型结构和网格/解数据。
4. `comsol_evaluate_results` 读取 `S11`、`|E|` 最大值/平均值/积分。
5. `comsol_export_results` 导出 S 参数 CSV、截线 CSV、场图 PNG。
6. `comsol_set_parameters` 修改几何/频率，另存新模型。
7. `comsol_run_model` 求解新模型（可异步）。
8. `comsol_parameter_sweep` 扫描频率/间隙/出口半径；超过阈值先确认。
9. `comsol_get_job_status` + `comsol_read_log` 检查每组状态和失败原因。
10. Agent 基于真实 CSV/日志提出下一轮参数，而不是凭“求解成功”下物理结论。

推荐首次使用顺序：`check_environment` → `create_model(solve=true)` → `evaluate_results` → `export_results`。确认链路后再做扫描。

---

## 9. 建模模板与物理假设

### `coaxial_conical_gap`

2D 轴对称空气域，多边形顶点（r, z，单位 mm）：

```
(r_in, 0) → (r_out, 0) → (r_out, z_feed) → (r_tip_out, z_tip)
         → (r_tip_in, z_tip) → (r_in, z_feed) → 闭合
```

- 底边（z=0）：同轴 TEM 端口，`PortName=1`，`Pin=P_in`，`zref=50 Ω`（COMSOL 默认）。
- 顶边（z=z_tip）：开放散射边界（`Scattering`）。
- 其余边界：默认 PEC（理想电导体）。
- 材料：用户声明的空气基线（`epsr=1, mur=1, sigma=0`）。
- 研究：频域，`plist=freq`。

**明确假设**（工具返回 `modelingAssumptions`）：

1. 只对空气/真空间隙建模；金属壁用 PEC 边界表示，**没有**实体金属域。
2. 同轴端口是 TEM 端口，按 `P_in` 归一化；不是任意模式/任意阻抗。
3. 圆锥出口是开放散射边界，**不是**匹配的第二端口。
4. 空气是用户声明的基准材料，**不是**等离子体。
5. 不含气体流动、传热或等离子体物理。
6. 2D 轴对称理想化；不含制造公差、三维不对称、支撑结构。

### 等离子体/气流

当前**没有**实现等离子体、气体流动或传热模板。这是有意的：没有电子密度、电子温度、碰撞频率、气体种类、压力、功率沉积模型等数据时，自动生成“等离子体模型”会制造伪科学结果。后续扩展必须先由用户提供模型假设与参数，并在工具返回中标注。

---

## 10. 单位与数据约定

- 模板几何单位：mm（`lengthUnit("mm")`），坐标与长度参数均按 mm 解释。
- 频率：COMSOL 表达式，如 `2.45[GHz]`。
- 功率：如 `1[W]`。
- `S11` 返回实部/虚部；`|S11| = hypot(re, im)`；`dB = 20 log10(|S11|)`。
- 评估的 `unit` 来自 COMSOL（例如 `V/m`、`V*m^2`）；不要假设单位。
- 2D 轴对称的 `IntSurface + intvolume` 结果是旋转体积分，单位为 `V*m^2`（对 `|E|` 而言）。
- CSV 使用 UTF-8 编码，逗号分隔，第一行为表头。

---

## 11. 测试

### 单元测试

```powershell
cd D:\comsol-agent
node --test test/unit.test.mjs
```

覆盖：配置/工作区、路径越界保护、文件名清洗、参数归一化、UTF-8/GBK 解码、日志分类与不确定性措辞。

结果：**9/9 通过**。

### 真实集成测试

```powershell
$env:COMSOL_AGENT_INTEGRATION = '1'
node --test test/integration.test.mjs
```

真实执行：环境检查 → 创建同轴空气段模型并求解 → 加载校验 → 评估 S11 → 修改频率并回读 → 运行求解 → 导出 S 参数/CSV/PNG/截线 → 2 组扫描 → 读日志。

结果：**1/1 通过**（约 161 s）。

### 插件全链路自测

```powershell
node scripts/selftest.mjs
```

覆盖 13 个步骤（含 deep 许可探针、创建/校验/评估/改参/运行/导出/扫描/状态/日志）。

结果：**13/13 通过**。

详细日志、数值和失败路径测试见 [TEST_REPORT.md](TEST_REPORT.md)。

---

## 12. 已知限制与尚未实现

1. **平台**：当前实现面向 Windows + COMSOL 6.2 Java API。其他版本需重新核对 API 方法；驱动会在编译/调用失败时明确报错，不会伪造成功。
2. **求解器接口**：使用 COMSOL 官方 Java API 与可选 `comsolbatch`；没有鼠标/屏幕坐标 GUI 自动化。
3. **等离子体/气流/传热**：未实现。缺少可信参数时不会自动编造。
4. **金属实体**：模板只用 PEC 边界表示金属，没有实体金属域；若需要热/流耦合，需要扩展几何与材料。
5. **端口**：模板固定同轴 TEM 端口 + 散射出口；没有通用波导端口、模式匹配或第二端口的自动匹配。
6. **原生 Parametric 研究步**：未使用，改为逐组独立运行以换取日志、失败隔离、超时/取消/续跑。代价是每组一次 COMSOL 启动（约 10–30 s）。
7. **S 参数频率列**：当前 CSV 以 `solution_index` 标识解；多频点研究的频率列尚未自动导出（可用 `tableExpressions` 自行评估相关表达式，或按每频点单独运行）。
8. **日志编码**：COMSOL 本地化标签在不同启动上下文可能乱码；驱动会丢弃含替换字符的标签，保留有效 Unicode 标签。工具的类型/标签以 `tag`/`type`/`identifier` 为准。
9. **许可模块枚举**：只验证“能检出许可并创建模型”；不会枚举 RF/等离子体等模块是否授权。需要模块级结论时，必须实际创建对应物理场并观察错误。
10. **COMOSL 案例库 `.mph`**：很多是需联网下载的预览占位文件；工具会检测并明确报告，不会当作完整模型。
11. **大型扫描**：默认阈值 12 组；超过需 `confirm=true`。插件不会自动判断机器负载或共享许可池的其他人。
12. **删除/覆盖**：不做自动删除；新建模型覆盖需显式 `overwrite=true`。
13. **远程访问**：没有远程桥接、端口监听或隧道。所有执行都在本机 Harness 主机进程内。
14. **图像质量**：导出的 PNG 是 COMSOL 默认表面图，可能没有坐标轴标题/图例；需要出版级图时请另行配置 plot group。
15. **模型校验深度**：`comsol_validate_model` 检查文件、加载、结构、网格/解；不做几何自交的严格数学证明或制造可行性判断。

---

## 13. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `COMSOL_NOT_FOUND` | 设置 `config.comsolHome` 为 `...\Multiphysics`，或设置 `COMSOL_HOME` |
| `COMSOL_JAVA_MISSING` / `COMSOL_JAVAC_MISSING` | 安装目录缺少 `java\win64\jre`；确认安装完整 |
| `DRIVER_COMPILE_FAILED` | 查看 `workspace/.driver/compile.log`；确认 COMSOL `plugins` 目录存在 |
| 许可错误 | 检查 `license.dat`、许可服务器/席位；`deep=true` 可验证真实检出 |
| `MODEL_IS_APPLICATION_LIBRARY_PREVIEW` | 这是案例库预览文件；从 COMSOL 案例库下载完整模型 |
| `PARAM_NOT_FOUND` | 参数名不在模型中；先用 `comsol_validate_model` 查看 `parameters` |
| `COMSOL_TIMEOUT` | 提高 `timeoutSec`，或减小网格/模型；任务状态为 `timeout`，结果无效 |
| `OUTPUT_OUTSIDE_WORKSPACE` | 把输出放到工作区，或在配置中加 `allowedRoots` |
| 扫描返回 `confirmation_required` | 检查估算后加 `confirm=true` |
| 每次调用约 10–30 s | COMSOL JVM 启动与许可检出开销；这是独立进程模型的代价 |
| 中文标签乱码 | 属于 COMSOL/JVM 本地化差异；工具会丢弃损坏标签，`tag/type` 不受影响 |

---

## 14. 文件清单

```
comsol-agent/
  index.js                  Host 插件入口（注册工具）
  package.json              bundle 清单（无第三方依赖）
  cordis.patch.yml          bundle 插入行
  locale/{zh,en}.json       显示名称与描述
  icon.svg                  插件图标
  lib/
    config.js               COMSOL 探测与配置
    environment.js          环境报告
    driver.js               Java 桥接编译/启动
    jobs.js                 任务队列、持久化、取消
    logs.js                 日志诊断
    paths.js                路径/工作区保护
    process.js              参数数组进程、超时、取消
    decode.js               UTF-8/GBK 解码
    schema.js               JSON Schema 片段与参数归一化
    tools.js                11 个工具实现
    plugin.js               组装
  java/
    ComsolBridge.java       COMSOL Java API 桥接（Jackson）
    build/                  本地编译产物（运行时会在工作区重新编译）
  test/
    unit.test.mjs           9 个单元测试
    integration.test.mjs    真实 COMSOL 集成测试
  scripts/
    selftest.mjs            13 步全链路自测
    test_sweep_log.mjs      扫描日志专项测试
    test_jobs.mjs           异步/取消/失败/超时专项测试
  examples/
    coaxial_conical_gap_demo.mph
    s_parameters.csv
    radial_line_z10.csv
    conical_gap_Enorm.png
    README.md
  docs/
    使用手册.md             完整图文教程（安装、首次仿真、工具、排错）
  test-logs/
    selftest.log            13 步全链路自测原始日志
    integration.log         真实集成测试原始日志
  README.md
  TEST_REPORT.md
```

示例产物来自本机真实运行，性质与假设见 [examples/README.md](examples/README.md)。
