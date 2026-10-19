# COMSOL 自动仿真助手 — 实际测试报告

测试日期：2026-10-19（Asia/Shanghai）  
测试主机：Windows 10.0.26200 x64  
COMSOL：`D:\COMSOL62\Multiphysics`，`COMSOL Multiphysics 6.2.0.290`  
插件版本：`@local/comsol-agent@1.0.0`

本报告只记录**实际执行**的测试。每项均标注“已执行并通过”“已执行但失败（预期失败路径）”或“尚未执行”。

> 为保护隐私，报告中的本机用户名与本地项目目录已替换为占位符（`C:\Users\<user>`、`D:\comsol-agent`）；数值、job id、时间、文件大小与错误码均未改动。随仓库附带的原始自测/集成日志位于 [test-logs](test-logs/)。

---

## 0. 结论摘要

| 测试层级 | 结果 |
|---|---|
| 单元测试（无需许可） | **9/9 通过** |
| 真实 COMSOL 集成测试（需要许可） | **1/1 通过**，约 154 s |
| 插件全链路自测（13 步） | **13/13 通过** |
| Harness 工具级调用 | 11 个工具均已通过当前会话真实调用 |
| 真实 COMSOL 求解 | 已生成解、S 参数、CSV、PNG；证据见下文 |
| 失败路径 | 预览文件、缺失参数、扫描阈值、超时、取消均按预期返回失败 |

**最重要的验收证据**：Harness 通过 `comsol_create_model` 在真实 COMSOL 中创建并求解了模型 `harness_conical_demo.mph`，得到 `sol1`（944 自由度、122 网格单元）与 `S11 = -0.002612 + 0.253224j`（`-11.93 dB`）。该模型、S 参数 CSV、截线 CSV 和 PNG 场图已复制到 [examples/](examples/)。

---

## 1. 环境检测证据

通过 Harness 工具 `comsol_check_environment(deep=true)` 执行。

| 项目 | 实测值 |
|---|---|
| COMSOL 安装 | `D:\COMSOL62\Multiphysics` |
| 版本 | `6.2.0.290`（来自 `comsolbatch -version`，ASCII 可解析） |
| `comsolbatch.exe` | 存在，956,392 bytes |
| `comsolcompile.exe` | 存在，956,392 bytes |
| `comsolmphserver.exe` | 存在，1,026,536 bytes |
| Java Runtime | `java\win64\jre`，`JAVA_VERSION="11.0.20"` |
| javac | 存在，13,312 bytes |
| API jar | `plugins\com.comsol.api_1.0.0.jar`，531,627 bytes |
| 许可文件 | `license\license.dat` 存在；`licenseinfo.ini` 可解析，LicenseNumber 非空 |
| 真实许可检出 | **成功**：Java API 创建模型并构建了一个 3D 几何（1 个域） |
| MATLAB | 检测到 `D:\matlab\2025a\bin\matlab.exe`；**未验证许可** |
| LiveLink | `mli` 目录与 `com.comsol.mli_1.0.0.jar` 存在；`installed-unverified` |

深度探针日志：`C:\Users\<user>\comsol-agent-workspace\.driver\environment-probe-1792380055306\log.txt`

---

## 2. 单元测试（9/9）

命令：

```powershell
cd D:\comsol-agent
node --test test/unit.test.mjs
```

```
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

覆盖内容：

1. `loadConfig` 工作区创建、拒绝无效 COMSOL home、允许根目录。
2. COMSOL 目录探测返回结构化候选。
3. 输出路径越界保护（`OUTPUT_OUTSIDE_WORKSPACE`）。
4. 文件名清洗（单位方括号、`.mph` 后缀）。
5. 参数归一化（数字转字符串、忽略非标量）。
6. UTF-8 与 GBK 解码。
7. 案例库预览日志分类。
8. 许可/网格日志分类与不确定性说明。
9. 无错误签名时明确“不证明物理正确”。

单元测试不依赖 COMSOL 许可。

---

## 3. 真实集成测试（1/1，约 154 s）

命令：

```powershell
$env:COMSOL_AGENT_INTEGRATION = '1'
node --test test/integration.test.mjs
```

实际覆盖并断言：

| 步骤 | 结果 |
|---|---|
| `comsol_check_environment` | `ok=true`，检测到 COMSOL 与版本 |
| `comsol_create_model(rf_coax_air, solve=true)` | 生成模型文件并求解 |
| `comsol_validate_model` | `modelOpen.ok=true`，物理场存在 |
| `comsol_evaluate_results(ewfd.S11)` | 返回有限数值 |
| `comsol_set_parameters(freq=2.40[GHz])` | 回读完全一致 |
| `comsol_run_model(study=std1, wait=true)` | `status=succeeded`，输出存在 |
| `comsol_export_results` | S 参数、表格、PNG、截线、积分 5 项全部存在且非空 |
| `comsol_parameter_sweep(2 组, wait=true)` | `2/2` 成功，两个输出均存在 |
| `comsol_read_log` | 返回结构化分析，行数 > 0 |

集成测试输出：

```
integration evidence: model=C:\Users\<user>\AppData\Local\Temp\comsol-agent-integration-ub3fq5\models\integration_coax.mph
integration evidence: S11(2.45GHz)=-3.556821666236149e-7
integration evidence: sweep=2/2
✔ real COMSOL: create, validate, evaluate, modify, run, export and sweep (153564.1978ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

原始日志：`test-logs/integration.log`  
（更早一次完整运行耗时 248.9 s，日志 `integration2.log`；两次均通过。）

说明：`rf_coax_air` 是均匀同轴空气段，底部同轴 TEM 端口、顶部吸收型散射边界；`S11≈0` 表示该简化模型在数值上接近匹配，**不代表**圆锥结构或任何实际器件已优化。

---

## 4. 插件全链路自测（13/13）

命令：

```powershell
cd D:\comsol-agent
node scripts/selftest.mjs
```

| # | 步骤 | 耗时 | 结果 |
|---|---|---:|---|
| 1 | `comsol_check_environment` | 6,496 ms | PASS |
| 2 | `comsol_check_environment(deep=true)` | 22,699 ms | PASS |
| 3 | `comsol_create_model(rf_coax_air, solve=true)` | 20,768 ms | PASS |
| 4 | `comsol_validate_model` | 15,908 ms | PASS |
| 5 | `comsol_evaluate_results`（global S11） | 15,751 ms | PASS |
| 6 | `comsol_evaluate_results`（体积分） | 15,808 ms | PASS |
| 7 | `comsol_evaluate_results`（截线） | 15,773 ms | PASS |
| 8 | `comsol_set_parameters` | 17,598 ms | PASS |
| 9 | `comsol_run_model(java, wait=true)` | 19,252 ms | PASS |
| 10 | `comsol_export_results` | 17,744 ms | PASS |
| 11 | `comsol_parameter_sweep(2 组, wait=true)` | 37,770 ms | PASS |
| 12 | `comsol_get_job_status` | 2 ms | PASS |
| 13 | `comsol_read_log` | 4 ms | PASS |

```
"passed": 13,
"failed": 0,
```

原始日志：`test-logs/selftest.log`  
自测工作区：`D:\comsol-agent\selftest-workspace`

---

## 5. Harness 工具级真实调用证据

以下均为通过当前 DeepSeek Harness 会话直接调用插件工具得到的真实结果。

### 5.1 创建并求解同轴圆锥基准模型

工具：`comsol_create_model`  
job：`job-20261019-112133-001-jroheo`

| 项目 | 实测值 |
|---|---|
| 输出模型 | `C:\Users\<user>\comsol-agent-workspace\models\harness_conical_demo.mph` |
| 文件大小 | 1,094,147 bytes |
| 几何 | 2D 轴对称，1 个域，6 条边界，6 个顶点 |
| 网格 | 122 单元，84 顶点 |
| 物理场 | `emw` / `ElectromagneticWavesFrequencyDomain`，标识符 `ewfd` |
| 端口 | `port1`，Coaxial，PortName 1，`P_in=1[W]` |
| 出口 | `sbc1`，Scattering |
| 研究 | `std1` / Frequency，`plist=freq` |
| 解 | `sol1`，944 自由度 × 1 |
| `S11` | real `-0.002612319963658014`，imag `0.25322426892246674` |
| `|S11|` | `0.2532377432116119` |
| `S11(dB)` | `-11.929431309038103` |

### 5.2 模型加载校验

工具：`comsol_validate_model`  
job：`job-20261019-112219-002-fd7t33`

- 文件层：存在、可读、`.mph`、1,094,147 bytes。
- `modelOpen.ok = true`，重新读回几何/物理场/研究/网格/解。
- `previewDetected = false`。

### 5.3 数值评估（max/min/avg + 均匀度公式）

工具：`comsol_evaluate_results`（`uniformity=true`）  
job：`job-20261019-112247-003-99slwl`

| 量（`ewfd.normE`，域 1） | 数值 | 单位 |
|---|---:|---|
| 最大值 | 8,281.906514735349 | V/m |
| 最小值 | 834.3523310828824 | V/m |
| 平均值 | 2,065.9792097924983 | V/m |
| 体积分（`IntSurface + intvolume`） | 0.021517504258762955 | V·m² |
| 均匀度 `U = 1-(max-min)/(max+min)` | 0.18304709096004057 | — |

均匀度是**用户请求的公式**，不是 COMSOL 标准量；只适用于非负场且 `max+min ≠ 0`。

### 5.4 结果导出

工具：`comsol_export_results`  
job：`job-20261019-112318-004-49sjgt`  
输出目录：`C:\Users\<user>\comsol-agent-workspace\exports\harness_conical_demo__20261019-112318`

| 项目 | 文件 | 行数/大小 |
|---|---|---|
| S 参数 | `s_parameters.csv` | 1 行数据，100 bytes |
| 全局表 | `table.csv` | 1 行，78 bytes |
| PNG 场图 | `conical_gap_Enorm.png` | 18,836 bytes，800×600 |
| 径向截线 | `radial_line_z10.csv` | 40 行，2,278 bytes |
| 体积分 | `volume_integral.csv` | 1 行，94 bytes |

S 参数 CSV 内容：

```
solution_index,S11,S11_mag,S11_dB
1,-0.00261231996366+0.253224268922j,0.253237743212,-11.9294313090
```

截线首行：

```
c0,c1,ewfd.normE_real,ewfd.normE_imag
4.50000000000,10.0000000000,2087.52707838,0.00000000000
```

### 5.5 参数修改与回读

工具：`comsol_set_parameters`  
job：`job-20261019-112357-005-nz7te8`

| 参数 | 旧值 | 新值 | 回读 | 精确匹配 |
|---|---|---|---|---|
| `freq` | `2.45[GHz]` | `2.40[GHz]` | `2.40[GHz]` | 是 |
| `z_tip` | `60` | `55` | `55` | 是 |
| `r_tip_out` | `6` | `5.5` | `5.5` | 是 |

输出：`C:\Users\<user>\comsol-agent-workspace\runs\harness_conical_demo__params_20261019-112357.mph`

### 5.6 参数扫描（2 频率 × 2 出口半径 = 4 组）

工具：`comsol_parameter_sweep`  
job：`job-20261019-112433-006-ushsv4`  
总耗时：126,994 ms  
结果：**4/4 成功，0 失败**

| 组 | `freq` | `r_tip_out` | 输出文件大小 | 耗时 |
|---|---|---:|---:|---:|
| 1 | 2.40 GHz | 5.5 | 1,093,273 | 34,433 ms |
| 2 | 2.40 GHz | 6.0 | 1,096,807 | 27,075 ms |
| 3 | 2.45 GHz | 5.5 | 1,093,228 | 28,762 ms |
| 4 | 2.45 GHz | 6.0 | 1,096,852 | 36,594 ms |

随后逐组读取 `ewfd.S11`（job `...-007` 至 `...-010`）：

| 组 | S11 实部 | S11 虚部 | `|S11|` | `dB` |
|---|---:|---:|---:|---:|
| 2.40 GHz, 5.5 | -0.0122549258 | 0.2578317873 | 0.258122866 | -11.763 |
| 2.40 GHz, 6.0 | -0.0312423305 | 0.2593404584 | 0.261215537 | -11.660 |
| 2.45 GHz, 5.5 | 0.0160080190 | 0.2500968216 | 0.250608613 | -12.020 |
| 2.45 GHz, 6.0 | -0.0026123200 | 0.2532242689 | 0.253237743 | -11.929 |

该结果只说明这 4 个参数点的数值趋势；**不构成**对圆锥结构的设计优化或物理验证。

### 5.7 Java API 求解（Harness 级）

工具：`comsol_run_model(engine="java", wait=true)`  
job：`job-20261019-112859-002-m6dcoy`  
状态：`succeeded`，37,274 ms  
输出：`runs\harness_conical_demo__params_20261019-112357__run_20261019-112859.mph`，1,096,002 bytes  
解：`sol1`，884 自由度。

### 5.8 comsolbatch 求解（Harness 级）

工具：`comsol_run_model(engine="batch", wait=true)`  
job：`job-20261019-112939-003-cm4m5r`  
状态：`succeeded`，48,523 ms  
实际输出：`runs\harness_conical_demo__run_20261019-112939.mph`，1,096,633 bytes  
退出码：0  
批处理日志显示：求解自由度数 944，求解时间 1 s，总时间 35 s，最后“正在保存模型”。

批处理同时给出 COMSOL 警告：“参数化求解器不支持求解器序列中的可变参数，请使用参数化扫描”。该警告未阻止求解，但说明 `plist=freq` 的写法在本模型中会触发提示；后续版本可改为显式频率列表。

### 5.9 异步任务、状态、取消、日志

- 异步启动 `comsol_run_model(wait=false)`：job `job-20261019-112831-011-0j26ks`，立即返回 `status=running`。
- `comsol_cancel_job`：任务最终 `status=cancelled`，`error.code=JOB_CANCELLED`，`outputExists=false`。
- 第二次取消测试：job `job-20261019-112851-001-7idd0l`，工具返回合法结构化 JSON，任务状态 `cancelled`。
- `comsol_read_log` 对该任务返回 `conclusion`：“The job was cancelled. Any output file may be incomplete.”
- `comsol_get_job_status` 返回日志尾部与进度。

### 5.10 逐表达式部分失败（Global 误用场量）

工具：`comsol_evaluate_results`  
job：`job-20261019-115533-001-qcq3bk`

请求：`kind="global"`，表达式 `["ewfd.S11", "ewfd.normE"]`。

实际结果：

- 任务状态：`failed`，顶层错误 `EVALUATION_PARTIAL_FAILURE`。
- `ewfd.S11`：成功返回 `real=-0.002612319963658014`、`imag=0.25322426892246674`。
- `ewfd.normE`：失败，`Failed_to_evaluate_expression`，并带 `hint`：
  “Global evaluation supports global scalar quantities such as S-parameters. Field expressions such as ewfd.normE must be evaluated with an integral, average, maximum, minimum, point or line kind.”

对照组：

| 请求 | job | 结果 |
|---|---|---|
| 仅 `ewfd.S11`，`global` | `job-20261019-115556-002-mlmyo5` | `succeeded`，值正确 |
| `ewfd.normE`，`volume_integral`，域 1 | `job-20261019-115613-003-6danu2` | `succeeded`，`IntSurface`，`0.021517504258762955 V·m²` |

导出部分失败：`comsol_export_results` 同时请求 `ewfd.normE`（有效）与 `ewfd.notAThing`（无效）  
job：`job-20261019-115632-004-xtms6y`

- 任务状态：`failed`，顶层错误 `EXPORT_PARTIAL_FAILURE`。
- 有效项：`partial_good.png` 生成，18,836 bytes，`fileChecks.ok=true`。
- 无效项：`fileChecks.ok=false`，错误 `Failed_to_evaluate_expression`。

结论：工具不会把“部分成功”报告为整体成功；成功的数据/文件仍保留，便于 Agent 继续分析，同时明确告知失败项。

### 5.11 参数扫描断点续跑

工具：`comsol_parameter_sweep(resumeJobId="job-20261019-112433-006-ushsv4")`  
job：`job-20261019-120456-007-0ork1b`

- 读取上一次扫描的 `sweep.json`，4 个组合均已完成，全部跳过。
- 任务耗时：**4 ms**；返回 `succeeded=4, failed=0`，并保留原输出文件路径与日志路径。
- 没有启动新的 COMSOL 求解。

说明：续跑任务的 `outputDir` 是新目录，但结果中保留原组合的真实输出路径；如需全部重算，不要传 `resumeJobId`。

### 5.12 覆盖保护与路径安全

| 场景 | 实际结果 |
|---|---|
| `run_model` 指定已存在的输出 `.mph`，未传 `overwrite` | 立即返回 `OUTPUT_EXISTS`；不启动 COMSOL |
| `export_results` 指定已存在 `s_parameters.csv` 的目录，未传 `overwrite` | 立即返回 `OUTPUT_EXISTS`，并列出 `collisions` |
| `export_results` 的 `filename="../evil.png"` | 立即返回 `INVALID_FILENAME`，拒绝路径穿越 |
| `parameter_sweep` 复用已有输出目录，未传 `overwrite` | `status=failed`、`OUTPUT_EXISTS`，耗时 6 ms，不覆盖已有 `.mph` |
| 同一扫描加 `overwrite=true` | `2/2` 成功（job `job-20261019-121938-001-vneaj3`） |
| `run_model` 对已存在输出加 `overwrite=true` | `succeeded`，job `job-20261019-122757-003-vxmo5y`，输出 1,096,562 bytes |
| `export_results` 对已存在 CSV 加 `overwrite=true` | `succeeded`，job `job-20261019-122818-004-9pyx7s` |

### 5.13 扫描汇总 CSV 与分阶段证据

**`comsol_run_model` 分阶段证据**（job `job-20261019-121808-001-9g1xl0`）：

```json
"executionEvidence": {
  "processStarted": true,
  "modelLoaded": true,
  "solveRequested": true,
  "studiesRun": ["std1"],
  "solutionsFound": 1,
  "solveCompleted": true,
  "outputWritten": true,
  "bridgeExitCode": 0
}
```

**扫描汇总 CSV**（成功 job `job-20261019-121938-001-vneaj3`）：

- `summaryCsv`：`...\sweeps\summary_test\sweep_summary.csv`
- 列：`index, freq, status, outputPath, outputExists, outputSizeBytes, durationMs, errorCode, errorMessage, logPath`
- 2 行均为 `succeeded`。

**失败任务不会覆盖成功汇总**（job `job-20261019-122022-002-ulhn0e`）：

- 同一输出目录、未传 `overwrite` → `OUTPUT_EXISTS`，耗时 7 ms。
- 稳定 `sweep_summary.csv` 仍保留上一次 2 行成功记录。
- 本次失败写入独立副本 `sweep_summary_job-20261019-122022-002-ulhn0e.csv`，其中 1 行为 `failed/OUTPUT_EXISTS`。

### 5.14 3D 开槽波导模板

新增 `rectangular_slot_launcher` 模板后，用 `comsol_create_model` 实际建了 5 个 3D 模型，全部求解成功。模型为 WR-340 波导 + 宽壁纵槽 + 石英窗 + 外部空气盒，网格 `hauto=5`。

| 算例 | 槽宽 | 偏移 | 脊高 | 网格 | 自由度 | S11 | S21 | 槽口 E 最小/最大/平均（1 W） | U |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 居中槽 | 4 mm | 0 | 0 | 9,957 | 67,684 | -58.79 dB | ~0 dB | 0.92 / 3.01 / 2.02 V/m | 0.468 |
| 居中槽 | 12 mm | 0 | 0 | 11,983 | 80,436 | -37.51 dB | -0.002 dB | 23.5 / 52.1 / 42.9 V/m | 0.622 |
| 偏移槽 | 12 mm | 20 mm | 0 | 11,796 | 79,302 | -15.59 dB | -1.32 dB | 206 / 1206 / 742 V/m | 0.292 |
| 偏移槽 | 8 mm | 20 mm | 0 | 10,625 | 71,860 | -20.94 dB | -0.49 dB | 166 / 863 / 552 V/m | 0.323 |
| 居中槽 + 脊 | 12 mm | 0 | 30 mm | 10,559 | 71,934 | -1.57 dB | -5.19 dB | 24.0 / 80.9 / 49.1 V/m | 0.458 |

关键 job：

- 居中 4 mm：`job-20261019-155815-001-b748tr`
- 居中 12 mm：`job-20261019-155912-002-e8q8o7`
- 偏移 20 mm / 12 mm：`job-20261019-160209-001-kqlpk0`
- 偏移 20 mm / 8 mm：`job-20261019-163211-004-4h1ti6`
- 居中 12 mm + 脊：`job-20261019-160048-001-wtw1ny`

多端口 S 参数导出修正后，`slot_offset20.mph` 的导出 job `job-20261019-163130-003-a48gfw` 返回 `ok=true`，CSV 包含 `S11`、`S21` 及幅度/dB 列；当前只激励端口 1，`S12`/`S22` 不可用，导出结果在 `skippedExpressions` 中明确列出，而不是让整项失败。

设计推导、尺寸和限制见 [宽幅微波等离子体源设计](docs/宽幅微波等离子体源设计.md)。

---

## 6. 预期失败路径测试

这些不是缺陷，而是安全/诊断设计的验证。

| 场景 | 工具调用 | 实际结果 |
|---|---|---|
| COMSOL 案例库预览文件 | `comsol_validate_model(circular_waveguide_filter.mph)` | 文件层通过；`modelOpen.ok=false`；`previewDetected=true`；错误码 `MODEL_IS_APPLICATION_LIBRARY_PREVIEW`；总 `ok=false` |
| 不存在的参数 | `comsol_set_parameters({not_a_real_parameter})` | `ok=false`；`PARAM_NOT_FOUND`；列出可用参数 |
| 扫描超过阈值 | `comsol_parameter_sweep`（3 组，阈值 2，未确认） | `ok=false`；`status=confirmation_required`；返回规模估算，未启动任何 COMSOL 求解 |
| 超时 | `comsol_create_model(timeoutSec=10)` | `status=timeout`；`COMSOL_TIMEOUT`；未伪造成功 |
| 取消 | `comsol_cancel_job` | `cancelled`；输出不存在；不会被标记成功 |
| 失败研究名 | `comsol_run_model(study="does_not_exist")` | `ok=false`；`STUDY_NOT_FOUND`；日志结论指出失败并列出可用研究 |
| 3D 槽长超过波导 | `comsol_create_model(slot_l=250, L=200)` | `ok=false`；`INVALID_SLOT`；未生成模型文件 |

预览文件 job：`job-20261019-113045-004-07ie49`  
缺失参数 job：`job-20261019-113050-005-e9uvac`

---

## 7. 验收过程中发现并修复的真实缺陷

这些问题是在真实运行中暴露并修复的，不是预先编写的示例：

1. **COMSOL Batch 禁止任意文件写入**  
   `comsolbatch` 下 `java.io` 写文件与 `model.save()` 会被 `AccessControlException` 拒绝。  
   → 架构改为“独立 JVM + COMSOL Java API”作为主执行层，`comsolbatch` 仅作为可选 engine。

2. **2D 轴对称体积分类型错误**  
   `IntVolume` 在 2D 轴对称数据集中返回 `Unsupported_geometry`。  
   → 使用 `IntSurface` + `intvolume=on`；边界面分使用 `IntLine` + `intsurface=on`。

3. **同轴端口求解报“参数 n 未定义”**  
   未赋材料时端口折射率无法解析。  
   → 模板显式创建并分配空气材料（`epsr=1, mur=1, sigma=0`）。

4. **网格为空（0 单元）**  
   仅创建 `mesh1` 不会自动生成自由三角形网格。  
   → 显式创建 `FreeTri`（2D）/`FreeTet`（3D）特征。

5. **取消任务返回不可序列化 Promise**  
   `comsol_cancel_job` 返回内部 `_promise`，Harness 报 “value is not lossless JSON”。  
   → 公共记录剥离所有 `_` 前缀字段，取消返回 `summarize()` 结果。

6. **失败的异步任务被报告为 `ok=true`**  
   `comsol_run_model` 在 `wait=true` 时未把最终失败映射到 `ok`。  
   → 改为最终 `status==='succeeded'` 才 `ok=true`。

7. **等待定时器导致 Node 进程不退出**  
   `waitFor` 的 `Promise.race` 未清理超时定时器。  
   → 定时器在任务完成时 `clearTimeout`，集成测试可正常退出。

8. **扫描任务没有聚合日志**  
   `comsol_read_log` 对扫描 job 报 `LOG_NOT_FOUND`。  
   → 扫描开始时创建 job 级 `log.txt`，每组追加状态行。

9. **自测重复运行被已有输出阻止**  
   `comsol_create_model` 默认不覆盖。  
   → 自测显式 `overwrite=true`；产品行为保持“默认不覆盖”。

10. **一个无效表达式拖垮整组评估**  
    原先一个 `Global` 特征同时承载多个表达式，`ewfd.normE` 在 Global 作用域无效会导致 `ewfd.S11` 也拿不到。  
    → 改为逐表达式独立评估；部分失败时仍返回成功值，任务标记 `failed`，错误项带 `hint`。

11. **部分失败没有反映到任务状态**  
    `doEvaluate`/`doExport`/参数回读原先只写 per-item `ok=false`，顶层仍为成功。  
    → 增加 `EVALUATION_PARTIAL_FAILURE`、`EXPORT_PARTIAL_FAILURE`、`PARAMETER_VERIFICATION_FAILED`，任务状态与工具 `ok` 一致。

12. **Java 驱动编译缓存不检测源文件更新**  
    `driver.compiled` 为 true 时直接复用旧 class，修改 `ComsolBridge.java` 后不会重新编译。  
    → 每次调用比较源文件与 class 的 mtime；源码更新即重新编译。

13. **输出文件可被静默覆盖**  
    `run_model`/`set_parameters`/`export_results`/`parameter_sweep` 指定已存在目标时没有默认拒绝。  
    → 增加 `overwrite=false` 默认保护、`OUTPUT_EXISTS` 错误、导出文件名路径穿越拒绝（`../`、`/`、`\`）。

14. **参数扫描缺少可导出的汇总文件**  
    扫描只有 JSON 结果，没有 CSV。  
    → 增加 `sweep_summary.csv`（job 目录 + 输出目录 jobId 副本 + 不轻易覆盖的稳定副本）。

---

## 8. 尚未执行 / 无法声称通过

| 项目 | 状态 | 原因 |
|---|---|---|
| 等离子体物理模型 | 未执行 | 缺少气体种类、压力、电子密度、电子温度、碰撞频率、功率沉积模型等必要数据；不得编造 |
| 气体流动/传热耦合 | 未执行 | 当前模板不含；需要额外几何、材料和边界条件 |
| 3D 同轴圆锥模型 | 未执行 | 当前模板为 2D 轴对称；3D 端口/网格策略需另行验证 |
| MATLAB LiveLink 调用 | 未执行 | 仅检测到安装文件，未验证 MATLAB 许可或 LiveLink 授权 |
| COMSOL 原生 Parametric 研究步 | 未执行 | 当前采用逐组独立运行；原因与取舍见 README |
| 大网格/长时间扫描/集群 | 未执行 | 测试只使用 122–数百单元的小模型 |
| 出版级图像/多物理场后处理 | 未执行 | 当前为 COMSOL 默认表面图 PNG |
| 制造可行性、几何自交严格证明 | 未执行 | 工具只做结构/网格/求解层面的检查 |
| 多端口/波导模式匹配 | 未执行 | 模板只有同轴 TEM 端口与散射出口 |
| Harness Web UI 中的插件图标视觉渲染 | 未验证 | 无浏览器控制；图标文件存在且为有效 SVG，但“看到”的渲染未截图确认 |

---

## 9. 复现命令

```powershell
# 单元测试
cd D:\comsol-agent
node --test test/unit.test.mjs

# 真实集成测试（需要一个可用 COMSOL 许可席位）
$env:COMSOL_AGENT_INTEGRATION = '1'
node --test test/integration.test.mjs
Remove-Item Env:COMSOL_AGENT_INTEGRATION

# 13 步全链路自测
node scripts/selftest.mjs

# 扫描日志专项
node scripts/test_sweep_log.mjs

# 异步/取消/失败/超时专项
node scripts/test_jobs.mjs
```

Harness 内复现：

```
comsol_check_environment(deep=true)
comsol_create_model(template="coaxial_conical_gap", name="demo", solve=true)
comsol_validate_model(modelPath="C:\Users\<user>\comsol-agent-workspace\models\demo.mph")
comsol_evaluate_results(modelPath="...demo.mph", expressions=["ewfd.normE"], kind="maximum", selection=[1], uniformity=true)
comsol_export_results(modelPath="...demo.mph", sParameters=true, fieldImages=[{expr:"ewfd.normE"}])
```

---

## 10. 原始证据位置

| 内容 | 路径 |
|---|---|
| 全链路自测日志 | `test-logs/selftest.log` |
| 集成测试日志 | `test-logs/integration.log` |
| 自测工作区与 job 记录 | `D:\comsol-agent\selftest-workspace\jobs\` |
| Harness job 记录 | `C:\Users\<user>\comsol-agent-workspace\jobs\` |
| Harness 创建模型 | `C:\Users\<user>\comsol-agent-workspace\models\harness_conical_demo.mph` |
| Harness 导出结果 | `C:\Users\<user>\comsol-agent-workspace\exports\harness_conical_demo__20261019-112318\` |
| Harness 扫描结果 | `C:\Users\<user>\comsol-agent-workspace\sweeps\harness_conical_demo__20261019-112433\` |
| 驱动编译日志 | `C:\Users\<user>\comsol-agent-workspace\.driver\compile.log` |

示例副本位于 [examples/](examples/)。
