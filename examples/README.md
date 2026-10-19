# 示例产物说明

这些文件来自 2026-10-19 在本机安装的 COMSOL Multiphysics 6.2.0.290 上通过 `comsol-agent` 插件真实创建、求解和导出的结果。

## 文件

| 文件 | 内容 |
|---|---|
| `coaxial_conical_gap_demo.mph` | 2D 轴对称同轴馈电圆锥环形间隙空气域模型（已求解） |
| `s_parameters.csv` | 同轴端口 `S11` 的复数、幅值和 dB |
| `radial_line_z10.csv` | z=10 mm 处沿半径方向的 `|E|` 截线数据（40 点） |
| `conical_gap_Enorm.png` | COMSOL 导出的 `|E|` 表面场图（800×600） |

## 模型参数

| 参数 | 值 |
|---|---|
| `r_in` | 4.35 mm |
| `r_out` | 10 mm |
| `z_feed` | 20 mm |
| `z_tip` | 60 mm |
| `r_tip_in` | 0.5 mm |
| `r_tip_out` | 6 mm |
| `freq` | 2.45 GHz |
| `P_in` | 1 W |

## 结果

- 网格：122 单元，84 顶点。
- 解：`sol1`，944 自由度 × 1。
- `S11 = -0.002612319963658014 + 0.25322426892246674j`
- `|S11| = 0.2532377432116119`，`S11 = -11.929 dB`

## 性质与限制（重要）

- 这是一个**电磁基准模型**：只对空气/真空间隙建模，金属壁用 PEC 边界表示，顶部是开放散射边界，不是匹配端口。
- **不包含**等离子体、气体流动、传热或实体金属域。
- 2D 轴对称理想化，不含制造公差、支撑结构或三维不对称。
- `S11 ≈ -11.9 dB` 只说明这个理想几何在 2.45 GHz 的数值反射；**不代表**结构已优化、可制造或物理结论正确。
- 示例 `.mph` 由本机 COMSOL 6.2 生成；其他 COMSOL 版本可能无法直接打开。
- 示例中的空气材料是用户声明的基线（`epsr=1, mur=1, sigma=0`），不是等离子体模型。

## 复现

```text
comsol_create_model(
  template="coaxial_conical_gap",
  name="coaxial_conical_gap_demo",
  solve=true,
  meshSize=4,
  templateParams={
    "r_in":"4.35","r_out":"10","z_feed":"20","z_tip":"60",
    "r_tip_in":"0.5","r_tip_out":"6","freq":"2.45[GHz]","P_in":"1[W]"
  }
)
comsol_export_results(
  modelPath="...coaxial_conical_gap_demo.mph",
  sParameters=true,
  fieldImages=[{"expr":"ewfd.normE","filename":"conical_gap_Enorm.png"}],
  lines=[{"exprs":["ewfd.normE"],"start":[4.5,10],"end":[9,10],"points":40}]
)
```
