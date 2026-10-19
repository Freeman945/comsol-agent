# comsol-agent

English | [简体中文](README.md)

COMSOL Multiphysics automation for DeepSeek Harness. The plugin runs inside the Harness host process and drives a local COMSOL installation through the official Java API. It covers environment checks, model validation, parameter edits, solves, parameter sweeps, result export and log diagnosis.

The Chinese user guide is in [docs/使用手册.md](docs/使用手册.md). Test records are in [TEST_REPORT.md](TEST_REPORT.md).

## Status

Tested on Windows 10 x64 with COMSOL 6.2.0.290 and the Java 11 runtime bundled with COMSOL. The following have been run end to end:

- environment detection and a real license checkout
- 2D axisymmetric coaxial-conical model creation, meshing and frequency-domain solve
- S11, field integrals, max/average and line interpolation
- a 4-case parameter sweep
- CSV and PNG export
- asynchronous jobs, cancellation, timeouts and log diagnosis

| Test | Result |
|---|---|
| Unit tests | 9/9 |
| Real COMSOL integration test | 1/1 (about 154 s) |
| 13-step self-test | 13/13 |

The example model gives `S11 = -0.002612 + 0.253224j`, or `0.2532` and `-11.93 dB`. That is a numerical result for an ideal air-filled geometry, not evidence that the structure has been optimized.

## How it works

```
DeepSeek Harness
  └─ comsol-agent (host plugin, Node.js)
       ├─ tool registration and argument validation
       ├─ job queue, timeouts, cancellation, logs
       └─ java.exe → ComsolBridge.java → COMSOL Java API
```

There is no server and no listening port. Each solve runs in a separate COMSOL JVM process. Jobs run one at a time by default so a sweep does not consume several license seats. The `java.exe`, `javac.exe` and `plugins\*` directories shipped with COMSOL are sufficient; no external JDK is required.

The default workspace is `%USERPROFILE%\comsol-agent-workspace`:

```
comsol-agent-workspace/
  jobs/       job records, logs and results
  models/     newly created models
  runs/       run output and parameter-edit output
  sweeps/     sweep output
  exports/    CSV and PNG files
  .driver/    compiled Java bridge classes
```

## Requirements

- Windows 10/11 x64
- COMSOL Multiphysics 6.2, with `bin\win64\comsolbatch.exe`, `java\win64\jre\bin\java.exe`, `javac.exe` and `plugins\com.comsol.api_*.jar`
- A working COMSOL license

MATLAB and LiveLink are only checked for installed files. Their licenses and APIs are not verified or used.

## Install

Place the plugin directory anywhere on the machine and install it through the Harness plugin manager:

```text
plugin_manager(
  action="install_bundle",
  target="D:\\path\\to\\comsol-agent"
)
```

A successful install returns `application: "applied"`, and 11 `comsol_*` tools appear in the tool list.

After editing JavaScript, disable and re-enable the plugin:

```text
plugin_manager(action="set_plugin", target="include:comsol-agent", enabled=false)
plugin_manager(action="set_plugin", target="include:comsol-agent", enabled=true)
```

Editing `java/ComsolBridge.java` does not require a reload. The next tool call recompiles it when the source timestamp is newer.

## Configuration

Configuration lives in the bundle row's `config` field. Every key is optional.

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

| Key | Default | Description |
|---|---|---|
| `workspaceRoot` | `%USERPROFILE%\comsol-agent-workspace` | Output root |
| `comsolHome` | auto-detected | Path to the `Multiphysics` directory |
| `allowedRoots` | workspace | Extra directories that outputs may use |
| `maxConcurrentJobs` | `1` | Number of COMSOL processes allowed at once |
| `maxSweepCombinations` | `12` | Maximum sweep size without explicit confirmation |
| `defaultTimeoutSec` | `600` | Default timeout |
| `javaHeap` | `-Xmx2g` | COMSOL JVM heap setting |

Auto-detection checks `COMSOL_HOME`, drive roots and `COMSOL*` directories under `Program Files`. A path is accepted only when both the batch executable and `plugins` exist.

## Tools

| Tool | Purpose |
|---|---|
| `comsol_check_environment` | COMSOL install, version, Java, license hints, MATLAB/LiveLink |
| `comsol_validate_model` | File checks plus an actual COMSOL load |
| `comsol_create_model` | Create a coaxial-conical or coaxial-air model |
| `comsol_set_parameters` | Edit global parameters, save and verify by reloading |
| `comsol_run_model` | Run an existing model with the Java API or comsolbatch |
| `comsol_parameter_sweep` | Cartesian sweep with cancellation and resume |
| `comsol_get_job_status` | Job status, progress and log path |
| `comsol_read_log` | Classify log errors and report confidence |
| `comsol_export_results` | Export S-parameters, tables, lines, integrals and PNGs |
| `comsol_evaluate_results` | Global values, integrals, min/max/avg and point/line data |
| `comsol_cancel_job` | Cancel a queued or running job |

Arguments and return fields are documented in the [Chinese user guide, section 8](docs/使用手册.md).

## Quick example

Create and solve a coaxial-conical model:

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

Read S11:

```text
comsol_evaluate_results(
  modelPath="...conical_demo.mph",
  expressions=["ewfd.S11"],
  kind="global"
)
```

Export S-parameters and a field image:

```text
comsol_export_results(
  modelPath="...conical_demo.mph",
  sParameters=true,
  fieldImages=[{"expr":"ewfd.normE","filename":"field.png"}],
  lines=[{"exprs":["ewfd.normE"],"start":[4.5,10],"end":[9,10],"points":40}]
)
```

For an existing model, the usual order is `validate_model` → inspect `physics/studies/parameters` → `run_model` if there is no solution → `evaluate_results` → `export_results`.

## Model templates

`coaxial_conical_gap` is a 2D axisymmetric air domain with these vertices in millimetres:

```
(r_in, 0) → (r_out, 0) → (r_out, z_feed) → (r_tip_out, z_tip)
         → (r_tip_in, z_tip) → (r_in, z_feed)
```

- Bottom edge: coaxial TEM port, `PortName=1`, default 50 Ω reference, `P_in` excitation
- Top edge: scattering boundary
- Other boundaries: default PEC
- Material: air (`epsr=1`, `mur=1`, `sigma=0`)
- Study: frequency domain, `plist=freq`

Only the air region is modelled. Metal walls are PEC boundaries, not solid domains. The template contains no plasma, gas flow or heat transfer. These assumptions are returned in `modelingAssumptions`.

`rf_coax_air` uses the same setup with a uniform coaxial air section, which is useful for a minimal connectivity test.

## Results and units

- Template geometry uses millimetres.
- `S11` is returned as real and imaginary parts. `|S11| = hypot(real, imag)` and `dB = 20 log10(|S11|)`.
- A 2D axisymmetric volume integral uses `IntSurface` with `intvolume=on`; its unit may be `V*m^2`, not `V`.
- A boundary integral uses `IntLine` with `intsurface=on`.
- Units in evaluation results come from COMSOL's `unit` field.
- `uniformity=true` uses the explicit formula `U = 1 - (max - min) / (max + min)`. It is not a built-in COMSOL quantity.

## Files and output protection

Outputs are restricted to the workspace. `set_parameters`, `run_model`, `export_results` and `parameter_sweep` return `OUTPUT_EXISTS` when a target file already exists; pass `overwrite=true` to replace it. Input models are never overwritten.

External programs are started with argument arrays, not shell strings. Executables are limited to fixed programs under the COMSOL installation. The plugin does not upload models, data or logs.

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

## Tests

```powershell
cd D:\comsol-agent

# Unit tests, no COMSOL license needed
node --test test/unit.test.mjs

# Real COMSOL integration test, license required
$env:COMSOL_AGENT_INTEGRATION = '1'
node --test test/integration.test.mjs
Remove-Item Env:COMSOL_AGENT_INTEGRATION

# 13-step self-test
node scripts/selftest.mjs
```

Logs are in `test-logs/`. Full results and failure-path tests are in [TEST_REPORT.md](TEST_REPORT.md).

## Limitations

- Plasma, gas flow and heat transfer are not implemented. The plugin will not generate such models without gas species, pressure, electron density, collision frequency and similar data.
- `create_model` currently has two 2D axisymmetric templates. Arbitrary geometry and 3D port setups do not have a generic interface yet.
- Parameter sweeps run one independent COMSOL process per case instead of a native Parametric study step. This keeps per-case logs, failure isolation and resume support, at the cost of one COMSOL startup per case.
- S-parameter CSV files use `solution_index`; multi-frequency studies do not yet get an automatic frequency column.
- MATLAB/LiveLink are checked for installed files only. Their licenses and APIs are not verified or called.
- The current implementation is verified against COMSOL 6.2. Other versions may need different API property names.
- Localized labels can be garbled depending on the launch context. Damaged labels are dropped; use `tag`, `type` and `identifier` instead.

## License

MIT License. See [LICENSE](LICENSE).

COMSOL Multiphysics is a trademark of COMSOL AB. This project is a third-party plugin, not affiliated with or endorsed by COMSOL AB.
