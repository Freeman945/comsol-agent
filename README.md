# comsol-agent

[English](README.en.md) | 简体中文

COMSOL Multiphysics 自动化插件，运行在 DeepSeek Harness 的主机进程中。通过 COMSOL 官方 Java API 完成模型校验、参数修改、求解、参数扫描、结果导出和日志诊断。

详细操作见 [使用手册](docs/使用手册.md)，真实测试记录见 [TEST_REPORT.md](TEST_REPORT.md)。

## 状态

本机环境：Windows 10 x64，COMSOL 6.2.0.290，COMSOL 自带 Java 11。已完成：

- 环境检测与真实许可检出
- 2D 轴对称同轴圆锥模型建模、网格和频域求解
- S11、场量积分、最大值/平均值、截线插值
- 4 组参数扫描
- CSV、PNG 导出
- 异步任务、取消、超时和日志诊断

| 测试 | 结果 |
|---|---|
| 单元测试 | 9/9 |
| 真实 COMSOL 集成测试 | 1/1（约 154 s） |
| 13 步自测 | 13/13 |

示例模型的 S11 为 `-0.002612 + 0.253224j`，即 `0.2532`、`-11.93 dB`。这只是一个空气填充理想几何的数值结果，不代表结构已经优化。

## 工作方式

```
DeepSeek Harness
  └─ comsol-agent（Host 插件，Node.js）
       ├─ 工具与参数校验
       ├─ 任务队列、超时、取消、日志
       └─ java.exe → ComsolBridge.java → COMSOL Java API
```

插件不启动服务，也不监听端口。每次求解是一个独立的 COMSOL JVM 进程，默认串行执行，避免占用多个许可席位。COMSOL 安装目录自带的 `java.exe`、`javac.exe` 和 `plugins\*` 就够用，不需要额外 JDK。

工作区默认在 `%USERPROFILE%\comsol-agent-workspace`：

```
comsol-agent-workspace/
  jobs/       任务记录、日志、结果
  models/     新建模型
  runs/       运行输出、参数修改输出
  sweeps/     扫描结果
  exports/    CSV、PNG
  .driver/    Java 桥接编译产物
```

## 环境要求

- Windows 10/11 x64
- COMSOL Multiphysics 6.2，安装目录下存在 `bin\win64\comsolbatch.exe`、`java\win64\jre\bin\java.exe`、`javac.exe`、`plugins\com.comsol.api_*.jar`
- 可用的 COMSOL 许可

MATLAB 和 LiveLink 只做安装检测，没有验证许可，也没有调用接口。

## 安装

插件目录放在本机任意位置，然后通过 Harness 的插件管理器安装：

```text
plugin_manager(
  action="install_bundle",
  target="D:\\path\\to\\comsol-agent"
)
```

成功时返回 `application: "applied"`，工具列表里会出现 11 个 `comsol_*` 工具。

修改 JS 代码后，关闭再启用插件即可重新加载：

```text
plugin_manager(action="set_plugin", target="include:comsol-agent", enabled=false)
plugin_manager(action="set_plugin", target="include:comsol-agent", enabled=true)
```

只改 `java/ComsolBridge.java` 时不用重载插件，下次调用会根据源文件时间戳重新编译。

## 配置

配置写在 bundle 行的 `config` 中，全部可选。

```yaml
- insert:
    - id: comsol-agent
      name: '@local/comsol-agent'
      config:
        comsolHome: 'D:\COMSOL62\Multiphysics'
        workspaceRoot: 'D:\comsol-agent-workspace'
        allowedRoots:
          - 'D:\comsol-data'
        maxConcurrentJobs: 1
        maxSweepCombinations: 12
        defaultTimeoutSec: 600
        javaHeap: '-Xmx4g'
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `workspaceRoot` | `%USERPROFILE%\comsol-agent-workspace` | 输出根目录 |
| `comsolHome` | 自动探测 | 指向 `...\Multiphysics` |
| `allowedRoots` | 工作区 | 允许写出的额外目录 |
| `maxConcurrentJobs` | `1` | 同时运行的 COMSOL 进程数 |
| `maxSweepCombinations` | `12` | 未确认时允许的最大扫描组数 |
| `defaultTimeoutSec` | `600` | 默认超时 |
| `javaHeap` | `-Xmx2g` | COMSOL JVM 堆参数 |

自动探测会检查 `COMSOL_HOME`、各盘根目录和 `Program Files` 下的 `COMSOL*` 目录，只有同时存在批处理程序和 `plugins` 才会采用。

## 工具

| 工具 | 用途 |
|---|---|
| `comsol_check_environment` | 检测安装、版本、Java、许可线索、MATLAB/LiveLink |
| `comsol_validate_model` | 文件检查 + COMSOL 实际加载 |
| `comsol_create_model` | 从零创建同轴圆锥或同轴空气段模型 |
| `comsol_set_parameters` | 改全局参数，保存并回读核对 |
| `comsol_run_model` | 运行已有模型，支持 Java API 和 comsolbatch |
| `comsol_parameter_sweep` | 多参数笛卡尔积扫描，支持取消和续跑 |
| `comsol_get_job_status` | 查询任务状态、进度和日志路径 |
| `comsol_read_log` | 读取日志并分类诊断 |
| `comsol_export_results` | 导出 S 参数、表格、截线、积分和 PNG |
| `comsol_evaluate_results` | 全局量、积分、最大/最小/平均、点/线插值 |
| `comsol_cancel_job` | 取消排队或运行中的任务 |

参数和返回值见 [使用手册第 8 节](docs/使用手册.md)。

## 快速示例

创建一个同轴馈电圆锥模型并求解：

```text
comsol_create_model(
  template="coaxial_conical_gap",
  name="conical_demo",
  solve=true,
  meshSize=4,
  templateParams={
    "r_in":"4.35","r_out":"10","z_feed":"20","z_tip":"60",
    "r_tip_in":"0.5","r_tip_out":"6","freq":"2.45[GHz]","P_in":"1[W]"
  }
)
```

读取 S11：

```text
comsol_evaluate_results(
  modelPath="...conical_demo.mph",
  expressions=["ewfd.S11"],
  kind="global"
)
```

导出 S 参数和场图：

```text
comsol_export_results(
  modelPath="...conical_demo.mph",
  sParameters=true,
  fieldImages=[{"expr":"ewfd.normE","filename":"field.png"}],
  lines=[{"exprs":["ewfd.normE"],"start":[4.5,10],"end":[9,10],"points":40}]
)
```

已有模型的标准顺序是：`validate_model` → 看 `physics/studies/parameters` → `run_model`（如果没有解）→ `evaluate_results` → `export_results`。

## 建模模板

`coaxial_conical_gap` 是一个 2D 轴对称空气域，顶点按逆时针排列（mm）：

```
(r_in, 0) → (r_out, 0) → (r_out, z_feed) → (r_tip_out, z_tip)
         → (r_tip_in, z_tip) → (r_in, z_feed)
```

- 底边是同轴 TEM 端口，`PortName=1`，默认参考阻抗 50 Ω，激励功率 `P_in`
- 顶边是散射边界
- 其余边界默认 PEC
- 材料是空气（`epsr=1, mur=1, sigma=0`）
- 研究类型是频域，`plist=freq`

模板只对空气区域建模，金属壁用 PEC 边界表示，没有实体金属域；不包含等离子体、气体流动和传热。这些限制会在工具返回的 `modelingAssumptions` 里列出。

`rf_coax_air` 是同样的设置，几何换成一段均匀同轴空气段，适合做最小连通性测试。

## 结果与单位

- 模板几何长度单位是 mm。
- `S11` 返回实部和虚部，`|S11| = hypot(real, imag)`，`dB = 20 log10(|S11|)`。
- 2D 轴对称的体积分使用 `IntSurface + intvolume=on`，单位可能是 `V*m^2`，不是 `V`。
- 边界面分使用 `IntLine + intsurface=on`。
- 评估结果的单位以 COMSOL 返回的 `unit` 为准。
- `uniformity=true` 时使用 `U = 1 - (max - min) / (max + min)`，这是显式公式，不是 COMSOL 标准量。

## 文件与许可

所有输出默认限制在工作区内。`set_parameters`、`run_model`、`export_results`、`parameter_sweep` 遇到已存在的目标文件会报 `OUTPUT_EXISTS`，需要显式 `overwrite=true` 才会替换。原始模型不会被覆盖。

外部程序使用参数数组启动，不拼接 shell 字符串；可执行文件限定为 COMSOL 目录下的固定程序；插件不上传模型、数据或日志。

```text
comsol-agent/
  index.js
  package.json
  cordis.patch.yml
  locale/
  lib/
  java/ComsolBridge.java
  docs/使用手册.md
  test/
  scripts/
  examples/
  test-logs/
  README.md
  README.en.md
  TEST_REPORT.md
  LICENSE
```

## 测试

```powershell
cd D:\comsol-agent

# 单元测试，不需要 COMSOL
node --test test/unit.test.mjs

# 真实 COMSOL 集成测试，需要许可
$env:COMSOL_AGENT_INTEGRATION = '1'
node --test test/integration.test.mjs
Remove-Item Env:COMSOL_AGENT_INTEGRATION

# 13 步自测
node scripts/selftest.mjs
```

日志在 `test-logs/`，完整记录和失败路径测试见 [TEST_REPORT.md](TEST_REPORT.md)。

## 限制

- 等离子体、气体流动、传热没有实现。缺少气体种类、压力、电子密度、碰撞频率等数据时不会自动生成这类模型。
- `create_model` 目前只有两个 2D 轴对称模板，任意几何和 3D 端口还没有通用接口。
- 参数扫描采用逐组独立运行，不是 COMSOL 原生 Parametric 研究步。这样做可以保留每组日志、失败隔离和断点续跑，代价是每组都要启动一次 COMSOL。
- S 参数 CSV 目前用 `solution_index` 标识解，多频点研究还没有自动频率列。
- MATLAB/LiveLink 只做了存在性检测，没有验证许可或调用。
- 当前实现针对 COMSOL 6.2 验证；其他版本可能需要调整 API 属性名。
- 本地化标签在不同启动上下文中可能乱码，工具会丢弃损坏标签，以 `tag/type/identifier` 为准。

## 许可证

MIT License，见 [LICENSE](LICENSE)。

COMSOL Multiphysics 是 COMSOL AB 的商标。本项目是第三方插件，与 COMSOL AB 无隶属关系，也未获得其背书。
