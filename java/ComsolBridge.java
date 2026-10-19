import com.comsol.model.*;
import com.comsol.model.util.*;
import com.comsol.model.physics.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;

import java.io.*;
import java.util.*;

// ComsolBridge <job.json> <result.json>
// Runs as a standalone COMSOL Java API process so exports and saves have normal file access.
public class ComsolBridge {
  static final ObjectMapper OM = new ObjectMapper();
  static final ObjectNode RESULT = OM.createObjectNode();
  static final long T0 = System.currentTimeMillis();
  static int TAG_SEQ = 0;

  public static void main(String[] args) {
    if (args.length < 2) {
      System.err.println("usage: ComsolBridge <job.json> <result.json>");
      System.exit(2);
    }
    File jobFile = new File(args[0]);
    File resultFile = new File(args[1]);
    JsonNode job = null;
    try {
      job = OM.readTree(jobFile);
    } catch (Throwable t) {
      System.err.println("Cannot read job file: " + t);
      System.exit(2);
    }

    RESULT.put("ok", false);
    RESULT.put("driver", "comsol-agent-java-bridge");
    RESULT.put("driverVersion", "1.0.0");
    String action = job.path("action").asText("");
    RESULT.put("action", action);

    try {
      ModelUtil.initStandalone(false);
      RESULT.put("comsolVersion", ModelUtil.getComsolVersion());
      RESULT.put("comsolVersionNumber", versionNumber(ModelUtil.getComsolVersion()));
      System.out.println("COMSOL_BRIDGE action=" + action);
      System.out.println("COMSOL_VERSION=" + ModelUtil.getComsolVersion());

      if ("probe".equals(action) || "version".equals(action)) {
        doProbe(job);
      } else if ("inspect".equals(action)) {
        doInspect(job);
      } else if ("run".equals(action)) {
        doRun(job);
      } else if ("set_params".equals(action)) {
        doSetParams(job);
      } else if ("evaluate".equals(action)) {
        doEvaluate(job);
      } else if ("export".equals(action)) {
        doExport(job);
      } else if ("create_model".equals(action)) {
        doCreateModel(job);
      } else {
        throw new BridgeException("UNKNOWN_ACTION", "Unknown action: " + action);
      }
      RESULT.put("ok", true);
    } catch (Throwable t) {
      RESULT.put("ok", false);
      ObjectNode err = RESULT.putObject("error");
      err.put("code", classify(t));
      err.put("message", safe(t.getMessage()));
      err.put("exception", t.getClass().getName());
      err.put("detail", firstLines(stackTrace(t), 40));
      System.out.println("COMSOL_BRIDGE_ERROR " + classify(t) + ": " + safe(t.getMessage()));
      t.printStackTrace(System.out);
    } finally {
      RESULT.put("elapsedMs", System.currentTimeMillis() - T0);
      try {
        File parent = resultFile.getParentFile();
        if (parent != null) parent.mkdirs();
        OM.writerWithDefaultPrettyPrinter().writeValue(resultFile, RESULT);
        System.out.println("BRIDGE_RESULT=" + resultFile.getAbsolutePath());
      } catch (Throwable t) {
        System.err.println("Cannot write result file: " + t);
      }
      System.out.flush();
      System.exit(0);
    }
  }

  // ------------------------------------------------------------------ actions

  static void doProbe(JsonNode job) throws Exception {
    // Force a license checkout; initStandalone can be lazy.
    String tag = ModelUtil.uniquetag("LicenseProbe");
    Model probe = ModelUtil.create(tag);
    probe.modelNode().create("comp1");
    probe.geom().create("geom1", 3);
    probe.geom("geom1").feature().create("blk1", "Block");
    probe.geom("geom1").feature("blk1").set("size", new double[]{1, 1, 1});
    probe.geom("geom1").run();
    RESULT.put("licenseCheckout", "ok");
    RESULT.put("licenseEvidence", "COMSOL Java API created a model and built a 3D geometry");
    RESULT.put("probeDomains", probe.geom("geom1").getNDomains());
    ModelUtil.remove(tag);
    RESULT.put("initialized", true);
  }

  static void doInspect(JsonNode job) throws Exception {
    Model m = loadModel(job);
    RESULT.set("model", modelSummary(m));
  }

  static void doRun(JsonNode job) throws Exception {
    Model m = loadModel(job);
    String modelPath = text(job, "modelPath");
    String outputPath = text(job, "outputPath");
    boolean solve = job.path("solve").asBoolean(true);
    boolean allowNewParams = job.path("allowNewParams").asBoolean(false);

    ArrayNode applied = applyParams(m, job.path("params"), !allowNewParams);
    RESULT.set("paramsApplied", applied);

    long solveStart = System.currentTimeMillis();
    ArrayNode studiesRun = OM.createArrayNode();
    if (solve) {
      String study = text(job, "study");
      if (study != null && study.length() > 0) {
        if (!contains(m.study().tags(), study)) {
          throw new BridgeException("STUDY_NOT_FOUND", "Study not found: " + study
              + "; available: " + Arrays.toString(m.study().tags()));
        }
        m.study(study).run();
        studiesRun.add(study);
      } else {
        String[] tags = m.study().tags();
        if (tags.length == 0) {
          throw new BridgeException("NO_STUDY", "Model has no study sequence to run");
        }
        for (int i = 0; i < tags.length; i++) {
          m.study(tags[i]).run();
          studiesRun.add(tags[i]);
        }
      }
    }
    RESULT.put("solveMs", System.currentTimeMillis() - solveStart);
    RESULT.set("studiesRun", studiesRun);

    if (outputPath != null && outputPath.length() > 0) {
      ensureParent(outputPath);
      System.out.println("SAVING_MODEL=" + outputPath);
      m.save(outputPath);
      RESULT.put("outputPath", outputPath);
      RESULT.put("outputExists", new File(outputPath).exists());
      RESULT.put("outputSizeBytes", new File(outputPath).length());
      if (!new File(outputPath).exists() || new File(outputPath).length() == 0) {
        throw new BridgeException("OUTPUT_MISSING", "COMSOL did not produce a non-empty output model: " + outputPath);
      }
    }
    RESULT.put("modelPath", modelPath);
    RESULT.set("solutions", solutionSummary(m));
    RESULT.set("model", modelSummary(m));
  }

  static void doSetParams(JsonNode job) throws Exception {
    String modelPath = required(job, "modelPath");
    String outputPath = required(job, "outputPath");
    if (samePath(modelPath, outputPath)) {
      throw new BridgeException("WOULD_OVERWRITE_INPUT",
          "outputPath equals modelPath; overwriting the original model is not allowed");
    }
    Model m = loadModel(job);
    ArrayNode applied = applyParams(m, job.path("params"), true);
    ensureParent(outputPath);
    m.save(outputPath);
    RESULT.put("outputPath", outputPath);
    RESULT.put("outputExists", new File(outputPath).exists());
    RESULT.put("outputSizeBytes", new File(outputPath).length());

    Model v = ModelUtil.load(ModelUtil.uniquetag("Verify"), outputPath);
    ArrayNode verified = OM.createArrayNode();
    Set<String> names = new LinkedHashSet<String>();
    JsonNode params = job.path("params");
    Iterator<String> it = params.fieldNames();
    while (it.hasNext()) names.add(it.next());
    for (String name : names) {
      ObjectNode row = OM.createObjectNode();
      row.put("name", name);
      row.put("newValue", params.path(name).asText());
      row.put("readBack", v.param().get(name));
      boolean exact = equalTrim(params.path(name).asText(), v.param().get(name));
      boolean numeric = false;
      try {
        double a = v.param().evaluate(v.param().get(name));
        double b = m.param().evaluate(name);
        numeric = closeEnough(a, b);
      } catch (Throwable t) {
        // Numeric comparison is optional.
      }
      row.put("matchesExactly", exact);
      row.put("matchesNumerically", numeric);
      row.put("ok", exact || numeric);
      verified.add(row);
    }
    RESULT.set("verification", verified);
    RESULT.set("paramsApplied", applied);
    RESULT.set("model", modelSummary(v));
    int verifyFailures = 0;
    for (int i = 0; i < verified.size(); i++) {
      if (!verified.get(i).path("ok").asBoolean(false)) verifyFailures++;
    }
    if (verifyFailures > 0) {
      throw new BridgeException("PARAMETER_VERIFICATION_FAILED",
          verifyFailures + " parameter(s) did not read back as requested; see verification[]");
    }
  }

  static void doEvaluate(JsonNode job) throws Exception {
    Model m = loadModel(job);
    JsonNode requests = job.path("requests");
    if (!requests.isArray() || requests.size() == 0) {
      throw new BridgeException("BAD_REQUEST", "requests must be a non-empty array");
    }
    ArrayNode results = RESULT.putArray("results");
    for (int i = 0; i < requests.size(); i++) {
      JsonNode req = requests.get(i);
      ObjectNode row = OM.createObjectNode();
      row.put("index", i);
      try {
        evaluateOne(m, req, row);
        if (!row.has("ok")) row.put("ok", true);
      } catch (Throwable t) {
        row.put("ok", false);
        ObjectNode err = row.putObject("error");
        err.put("code", classify(t));
        err.put("message", safe(t.getMessage()));
      }
      results.add(row);
    }
    int failed = 0;
    for (int i = 0; i < results.size(); i++) {
      if (!results.get(i).path("ok").asBoolean(true)) failed++;
    }
    if (failed > 0) {
      throw new BridgeException("EVALUATION_PARTIAL_FAILURE",
          failed + " evaluation request(s) failed; inspect results[] for per-expression errors");
    }
  }

  static void doExport(JsonNode job) throws Exception {
    Model m = loadModel(job);
    JsonNode items = job.path("items");
    if (!items.isArray() || items.size() == 0) {
      throw new BridgeException("BAD_REQUEST", "items must be a non-empty array");
    }
    ArrayNode results = RESULT.putArray("items");
    for (int i = 0; i < items.size(); i++) {
      JsonNode item = items.get(i);
      ObjectNode row = OM.createObjectNode();
      row.put("index", i);
      String kind = item.path("kind").asText("");
      row.put("kind", kind);
      try {
        if ("sparameters".equals(kind)) exportSparameters(m, item, row);
        else if ("table".equals(kind)) exportTable(m, item, row);
        else if ("samples".equals(kind)) exportSamples(m, item, row);
        else if ("line".equals(kind)) exportLine(m, item, row);
        else if ("image".equals(kind)) exportImage(m, item, row);
        else if ("integral".equals(kind)) exportIntegral(m, item, row);
        else throw new BridgeException("UNKNOWN_EXPORT_KIND", "Unknown export kind: " + kind);
        row.put("ok", true);
      } catch (Throwable t) {
        row.put("ok", false);
        ObjectNode err = row.putObject("error");
        err.put("code", classify(t));
        err.put("message", safe(t.getMessage()));
      }
      results.add(row);
    }
    int failed = 0;
    for (int i = 0; i < results.size(); i++) {
      if (!results.get(i).path("ok").asBoolean(false)) failed++;
    }
    if (failed > 0) {
      throw new BridgeException("EXPORT_PARTIAL_FAILURE",
          failed + " export item(s) failed; inspect items[] for per-item errors and successful files");
    }
  }

  static void doCreateModel(JsonNode job) throws Exception {
    String template = job.path("template").asText("coaxial_conical_gap");
    String outputPath = required(job, "outputPath");
    if (new File(outputPath).exists() && !job.path("overwrite").asBoolean(false)) {
      throw new BridgeException("OUTPUT_EXISTS", "Output model exists; pass overwrite=true to replace: " + outputPath);
    }
    Model m;
    if ("coaxial_conical_gap".equals(template)) {
      m = createCoaxConicalGap(job);
      RESULT.put("template", "coaxial_conical_gap");
    } else if ("rf_coax_air".equals(template)) {
      m = createRfCoaxAir(job);
      RESULT.put("template", "rf_coax_air");
    } else if ("rectangular_slot_launcher".equals(template)) {
      m = createRectangularSlotLauncher(job);
      RESULT.put("template", "rectangular_slot_launcher");
    } else {
      throw new BridgeException("UNKNOWN_TEMPLATE", "Unknown template: " + template
          + "; supported: coaxial_conical_gap, rf_coax_air, rectangular_slot_launcher");
    }

    boolean solve = job.path("solve").asBoolean(false);
    if (solve) {
      long solveStart = System.currentTimeMillis();
      m.study("std1").run();
      RESULT.put("solveMs", System.currentTimeMillis() - solveStart);
      RESULT.put("solved", true);
      RESULT.set("solutions", solutionSummary(m));
      try {
        NumericalFeature s11 = m.result().numerical().create("s11_check", "Global");
        s11.set("expr", new String[]{"ewfd.S11"});
        double[][][] c = s11.getComplex();
        ObjectNode s = RESULT.putObject("s11");
        s.put("real", c[0][0][0]);
        s.put("imag", c[1][0][0]);
        s.put("magnitude", Math.hypot(c[0][0][0], c[1][0][0]));
        s.put("db", 20.0 * Math.log10(Math.max(Math.hypot(c[0][0][0], c[1][0][0]), 1e-30)));
      } catch (Throwable t) {
        RESULT.put("s11Error", safe(t.getMessage()));
      }
      if ("rectangular_slot_launcher".equals(template)) {
        try {
          NumericalFeature s21 = m.result().numerical().create("s21_check", "Global");
          s21.set("expr", new String[]{"ewfd.S21"});
          double[][][] c21 = s21.getComplex();
          ObjectNode s = RESULT.putObject("s21");
          s.put("real", c21[0][0][0]);
          s.put("imag", c21[1][0][0]);
          s.put("magnitude", Math.hypot(c21[0][0][0], c21[1][0][0]));
          s.put("db", 20.0 * Math.log10(Math.max(Math.hypot(c21[0][0][0], c21[1][0][0]), 1e-30)));
        } catch (Throwable t) {
          RESULT.put("s21Error", safe(t.getMessage()));
        }
        try {
          double bb = evalParam(m, "b");
          double tm = evalParam(m, "t_m");
          double tq = evalParam(m, "t_q");
          double slotL = evalParam(m, "slot_l");
          double L = evalParam(m, "L");
          double z0 = (L - slotL) / 2.0;
          double yProbe = bb / 2 + tm + tq + 2.0;
          double[][] coords = new double[3][51];
          for (int i = 0; i < 51; i++) {
            coords[0][i] = evalParam(m, "slot_offset");
            coords[1][i] = yProbe;
            coords[2][i] = z0 + slotL * i / 50.0;
          }
          NumericalFeature ip = m.result().numerical().create(tag("slotline"), "Interp");
          ip.set("expr", new String[]{"ewfd.normE"});
          ip.set("coorderr", "off");
          ip.set("coord", coords);
          double[][][] data = ip.getData();
          if (data.length > 0 && data[0].length > 0) {
            double[] vals = data[0][0];
            double min = 1e300, max = -1e300, sum = 0;
            for (int i = 0; i < vals.length; i++) {
              min = Math.min(min, vals[i]);
              max = Math.max(max, vals[i]);
              sum += vals[i];
            }
            ObjectNode sf = RESULT.putObject("slotField");
            sf.put("expression", "ewfd.normE");
            sf.put("points", vals.length);
            sf.put("probeY", yProbe);
            sf.put("min", min);
            sf.put("max", max);
            sf.put("mean", sum / vals.length);
            sf.put("uniformity", (max + min) != 0 ? 1.0 - (max - min) / (max + min) : 0.0);
          }
        } catch (Throwable t) {
          RESULT.put("slotFieldError", safe(t.getMessage()));
        }
      }
    } else {
      RESULT.put("solved", false);
    }

    ensureParent(outputPath);
    m.save(outputPath);
    RESULT.put("outputPath", outputPath);
    RESULT.put("outputExists", new File(outputPath).exists());
    RESULT.put("outputSizeBytes", new File(outputPath).length());
    RESULT.set("model", modelSummary(m));
  }

  static Model createCoaxConicalGap(JsonNode job) throws Exception {
    JsonNode p = job.path("templateParams");
    Model m = ModelUtil.create(ModelUtil.uniquetag("CoaxConicalGap"));
    m.modelNode().create("comp1");
    setDefaultParams(m, p);
    GeomSequence g = m.geom().create("geom1", 2);
    g.axisymmetric(true);
    g.lengthUnit("mm");
    g.label("Axisymmetric air gap");
    GeomFeature pol = g.feature().create("gap", "Polygon");
    pol.label("Conical annular gap (air)");
    pol.set("source", "table");
    pol.set("table", new String[][]{
        {"r_in", "0"},
        {"r_out", "0"},
        {"r_out", "z_feed"},
        {"r_tip_out", "z_tip"},
        {"r_tip_in", "z_tip"},
        {"r_in", "z_feed"}
    });
    g.run();
    int ndom = g.getNDomains();
    if (ndom != 1) {
      RESULT.put("geometryWarning", "Expected 1 air domain, got " + ndom);
    }
    int bottom = findEdgeByZ(g, 0.0, 1e-6);
    int top = findEdgeByZ(g, evalParam(m, "z_tip"), 1e-6);
    if (bottom < 0 || top < 0) {
      throw new BridgeException("PORT_EDGE_NOT_FOUND",
          "Could not locate bottom/top boundary by z coordinate (bottom=" + bottom + ", top=" + top + ")");
    }
    RESULT.put("portEdge", bottom);
    RESULT.put("outletEdge", top);

    addAirMaterial(m);
    Physics emw = m.physics().create("emw", "ElectromagneticWavesFrequencyDomain", "geom1");
    emw.label("Electromagnetic Waves, Frequency Domain");
    String prefix = emw.identifier();
    PhysicsFeature port = emw.create("port1", "Port", 1);
    port.label("Coaxial TEM input port");
    port.set("PortType", "Coaxial");
    port.set("PortName", "1");
    port.set("Pin", "P_in");
    port.selection().set(new int[]{bottom});
    PhysicsFeature sbc = emw.create("sbc1", "Scattering", 1);
    sbc.label("Open scattering outlet");
    sbc.selection().set(new int[]{top});

    Study std = m.study().create("std1");
    std.label("Frequency-domain study");
    StudyFeature freqStep = std.create("freq", "Frequency");
    freqStep.label("Frequency sweep");
    freqStep.set("plist", "freq");
    int hauto = job.path("meshSize").asInt(4);
    buildMesh(m, 2, hauto);
    RESULT.put("variablePrefix", prefix);
    RESULT.put("portTag", "port1");
    RESULT.put("outletBoundaryTag", "sbc1");
    RESULT.set("modelingAssumptions", assumptionsCoaxGap());
    return m;
  }

  static Model createRfCoaxAir(JsonNode job) throws Exception {
    JsonNode p = job.path("templateParams");
    Model m = ModelUtil.create(ModelUtil.uniquetag("RfCoaxAir"));
    m.modelNode().create("comp1");
    setDefaultParams(m, p);
    GeomSequence g = m.geom().create("geom1", 2);
    g.axisymmetric(true);
    g.lengthUnit("mm");
    g.label("Axisymmetric air gap");
    GeomFeature r = g.feature().create("air", "Rectangle");
    r.label("Coaxial air section");
    r.set("size", new String[]{"r_out-r_in", "z_feed"});
    r.set("pos", new String[]{"r_in", "0"});
    g.run();
    int bottom = findEdgeByZ(g, 0.0, 1e-6);
    int top = findEdgeByZ(g, evalParam(m, "z_feed"), 1e-6);
    if (bottom < 0 || top < 0) {
      throw new BridgeException("PORT_EDGE_NOT_FOUND", "Could not locate port boundaries");
    }
    addAirMaterial(m);
    Physics emw = m.physics().create("emw", "ElectromagneticWavesFrequencyDomain", "geom1");
    emw.label("Electromagnetic Waves, Frequency Domain");
    PhysicsFeature port = emw.create("port1", "Port", 1);
    port.label("Coaxial TEM input port");
    port.set("PortType", "Coaxial");
    port.set("PortName", "1");
    port.set("Pin", "P_in");
    port.selection().set(new int[]{bottom});
    PhysicsFeature sbc = emw.create("sbc1", "Scattering", 1);
    sbc.label("Open scattering outlet");
    sbc.selection().set(new int[]{top});
    Study std = m.study().create("std1");
    std.label("Frequency-domain study");
    StudyFeature freqStep = std.create("freq", "Frequency");
    freqStep.label("Frequency sweep");
    freqStep.set("plist", "freq");
    buildMesh(m, 2, job.path("meshSize").asInt(4));
    RESULT.put("variablePrefix", emw.identifier());
    RESULT.put("portEdge", bottom);
    RESULT.put("outletEdge", top);
    RESULT.set("modelingAssumptions", assumptionsCoaxGap());
    return m;
  }

  static Model createRectangularSlotLauncher(JsonNode job) throws Exception {
    JsonNode p = job.path("templateParams");
    Model m = ModelUtil.create(ModelUtil.uniquetag("SlotLauncher"));
    m.modelNode().create("comp1");
    setSlotParams(m, p);
    double a = evalParam(m, "a");
    double b = evalParam(m, "b");
    double L = evalParam(m, "L");
    double tm = evalParam(m, "t_m");
    double tq = evalParam(m, "t_q");
    double quartzW = evalParam(m, "quartz_w");
    double outH = evalParam(m, "outer_h");
    double outX = evalParam(m, "outer_x");
    double margin = evalParam(m, "margin");

    GeomSequence g = m.geom().create("geom1", 3);
    g.lengthUnit("mm");
    g.label("Rectangular waveguide slot launcher");

    GeomFeature wg = g.feature().create("wg", "Block");
    wg.label("WR-340 waveguide air");
    wg.set("size", new String[]{"a", "b", "L"});
    wg.set("pos", new String[]{"-a/2", "-b/2", "0"});

    String waveguideTag = "wg";
    if (evalParam(m, "ridge_h") > 0) {
      GeomFeature ridge = g.feature().create("ridge", "Block");
      ridge.label("Ridge under slot");
      ridge.set("size", new String[]{"ridge_w", "ridge_h", "ridge_l"});
      ridge.set("pos", new String[]{"slot_offset-ridge_w/2", "-b/2", "(L-ridge_l)/2"});
      GeomFeature cut = g.feature().create("wgcut", "Difference");
      cut.selection("input").set("wg");
      cut.selection("input2").set("ridge");
      waveguideTag = "wgcut";
    }

    GeomFeature slot = g.feature().create("slot", "Block");
    slot.label("Slot air volume");
    slot.set("size", new String[]{"slot_w", "t_m", "slot_l"});
    slot.set("pos", new String[]{"slot_offset-slot_w/2", "b/2", "(L-slot_l)/2"});

    GeomFeature quartz = g.feature().create("quartz", "Block");
    quartz.label("Fused silica window");
    quartz.set("size", new String[]{"quartz_w", "t_q", "quartz_l"});
    quartz.set("pos", new String[]{"slot_offset-quartz_w/2", "b/2+t_m", "(L-quartz_l)/2"});

    GeomFeature qtool = g.feature().create("qtool", "Block");
    qtool.set("size", new String[]{"quartz_w", "t_q", "quartz_l"});
    qtool.set("pos", new String[]{"slot_offset-quartz_w/2", "b/2+t_m", "(L-quartz_l)/2"});

    GeomFeature outer = g.feature().create("outer", "Block");
    outer.label("Open air above slot");
    outer.set("size", new String[]{"outer_x", "outer_h", "L+2*margin"});
    outer.set("pos", new String[]{"-outer_x/2", "b/2+t_m", "-margin"});

    GeomFeature dif = g.feature().create("dif1", "Difference");
    dif.selection("input").set("outer");
    dif.selection("input2").set("qtool");

    GeomFeature uni = g.feature().create("uni1", "Union");
    uni.selection("input").set(waveguideTag, "slot", "dif1", "quartz");
    g.run();

    int ndom = g.getNDomains();
    double[][] boxes = domainBoxes(g);
    int[] airIds = new int[boxes.length];
    int nAir = 0;
    int quartzId = -1;
    for (int i = 0; i < boxes.length; i++) {
      double[] bx = boxes[i];
      boolean isQuartz = Math.abs(bx[2] - (b / 2 + tm)) < 1e-3
          && Math.abs(bx[3] - (b / 2 + tm + tq)) < 1e-3
          && (bx[1] - bx[0]) < quartzW + 1e-3;
      if (isQuartz) {
        quartzId = i + 1;
      } else {
        airIds[nAir++] = i + 1;
      }
    }
    if (quartzId < 0) {
      throw new BridgeException("QUARTZ_DOMAIN_NOT_FOUND", "Could not identify the quartz window domain");
    }

    Material air = m.material().create("mat1", "Common");
    air.label("Air");
    air.selection().set(Arrays.copyOf(airIds, nAir));
    air.propertyGroup("def").set("relpermittivity", "1");
    air.propertyGroup("def").set("relpermeability", "1");
    air.propertyGroup("def").set("electricconductivity", "0");

    Material q = m.material().create("mat2", "Common");
    q.label("Fused silica (assumed)");
    q.selection().set(new int[]{quartzId});
    q.propertyGroup("def").set("relpermittivity", m.param().get("quartz_er"));
    q.propertyGroup("def").set("relpermeability", "1");
    q.propertyGroup("def").set("electricconductivity", "0");

    int p1f = bigFaceAt(g, 2, 0, 1e-6);
    int p2f = bigFaceAt(g, 2, L, 1e-6);
    if (p1f < 0 || p2f < 0) {
      throw new BridgeException("PORT_FACE_NOT_FOUND", "Could not locate waveguide port faces");
    }
    Physics emw = m.physics().create("emw", "ElectromagneticWavesFrequencyDomain", "geom1");
    emw.label("Electromagnetic Waves, Frequency Domain");
    PhysicsFeature p1 = emw.create("port1", "Port", 2);
    p1.label("WR-340 TE10 input");
    p1.set("PortType", "Rectangular");
    p1.set("PortName", "1");
    p1.set("PortModeType", "TE");
    p1.set("PortModeNumber", "10");
    p1.set("Pin", "P_in");
    p1.selection().set(new int[]{p1f});
    PhysicsFeature p2 = emw.create("port2", "Port", 2);
    p2.label("WR-340 TE10 output");
    p2.set("PortType", "Rectangular");
    p2.set("PortName", "2");
    p2.set("PortModeType", "TE");
    p2.set("PortModeNumber", "10");
    p2.set("PortExcitation", "off");
    p2.selection().set(new int[]{p2f});

    LinkedHashSet<Integer> scatSet = new LinkedHashSet<Integer>();
    addAll(scatSet, facesAtPlane(g, 1, b / 2 + tm + outH, 1e-6));
    addAll(scatSet, facesAtPlane(g, 0, -outX / 2, 1e-6));
    addAll(scatSet, facesAtPlane(g, 0, outX / 2, 1e-6));
    addAll(scatSet, facesAtPlane(g, 2, -margin, 1e-6));
    addAll(scatSet, facesAtPlane(g, 2, L + margin, 1e-6));
    int[] scat = new int[scatSet.size()];
    int si = 0;
    for (int f : scatSet) scat[si++] = f;
    PhysicsFeature sbc = emw.create("sbc1", "Scattering", 2);
    sbc.label("Open half-space boundary");
    sbc.selection().set(scat);

    Study std = m.study().create("std1");
    std.label("Frequency-domain study");
    StudyFeature freqStep = std.create("freq", "Frequency");
    freqStep.label("Frequency sweep");
    freqStep.set("plist", "freq");
    buildMesh(m, 3, job.path("meshSize").asInt(5));

    RESULT.put("dimension", 3);
    RESULT.put("domains", ndom);
    RESULT.put("quartzDomain", quartzId);
    RESULT.put("portFaces", p1f + "," + p2f);
    RESULT.put("scatteringFaces", scat.length);
    RESULT.put("ridgeHeight", evalParam(m, "ridge_h"));
    RESULT.put("slotOffset", evalParam(m, "slot_offset"));
    RESULT.set("modelingAssumptions", assumptionsSlotLauncher(m));
    return m;
  }

  static void setSlotParams(Model m, JsonNode p) throws Exception {
    setParamDefault(m, p, "a", "86.36");
    setParamDefault(m, p, "b", "43.18");
    setParamDefault(m, p, "L", "200");
    setParamDefault(m, p, "slot_l", "150");
    setParamDefault(m, p, "slot_w", "4");
    setParamDefault(m, p, "slot_offset", "20");
    setParamDefault(m, p, "t_m", "2");
    setParamDefault(m, p, "t_q", "4");
    setParamDefault(m, p, "quartz_w", "10");
    setParamDefault(m, p, "quartz_l", "160");
    setParamDefault(m, p, "quartz_er", "3.8");
    setParamDefault(m, p, "outer_h", "100");
    setParamDefault(m, p, "outer_x", "120");
    setParamDefault(m, p, "margin", "20");
    setParamDefault(m, p, "ridge_h", "30");
    setParamDefault(m, p, "ridge_w", "30");
    setParamDefault(m, p, "ridge_l", "170");
    setParamDefault(m, p, "freq", "2.45[GHz]");
    setParamDefault(m, p, "P_in", "1[W]");
    String[] names = {"a", "b", "L", "slot_l", "slot_w", "slot_offset", "t_m", "t_q", "quartz_w",
        "quartz_l", "quartz_er", "outer_h", "outer_x", "margin", "ridge_h", "ridge_w",
        "ridge_l", "freq", "P_in"};
    for (int i = 0; i < names.length; i++) {
      m.param().evaluate(m.param().get(names[i]));
    }
    double Lv = evalParam(m, "L");
    double slotL = evalParam(m, "slot_l");
    double slotW = evalParam(m, "slot_w");
    double quartzW = evalParam(m, "quartz_w");
    double quartzL = evalParam(m, "quartz_l");
    double offset = evalParam(m, "slot_offset");
    double ridgeH = evalParam(m, "ridge_h");
    double ridgeL = evalParam(m, "ridge_l");
    double bv = evalParam(m, "b");
    if (slotL > Lv) throw new BridgeException("INVALID_SLOT", "slot_l must not exceed L");
    if (quartzL < slotL) throw new BridgeException("INVALID_QUARTZ", "quartz_l must be >= slot_l");
    if (quartzW < slotW) throw new BridgeException("INVALID_QUARTZ", "quartz_w must be >= slot_w");
    if (Math.abs(offset) + quartzW / 2 > evalParam(m, "a") / 2 + 1e-9) {
      throw new BridgeException("INVALID_SLOT_OFFSET", "slot_offset + quartz_w/2 exceeds the broad wall");
    }
    if (ridgeH >= bv) throw new BridgeException("INVALID_RIDGE", "ridge_h must be smaller than b");
    if (ridgeH > 0 && ridgeL > Lv) throw new BridgeException("INVALID_RIDGE", "ridge_l must not exceed L");
  }

  static double[][] domainBoxes(GeomSequence g) {
    double[][] v = g.getVertexCoord();
    int[][] adj = g.getAdj(3, 0);
    double[][] boxes = new double[adj.length - 1][];
    for (int i = 1; i < adj.length; i++) {
      double xmin = 1e9, xmax = -1e9, ymin = 1e9, ymax = -1e9, zmin = 1e9, zmax = -1e9;
      for (int k = 0; k < adj[i].length; k++) {
        int idx = adj[i][k] - 1;
        if (idx < 0) continue;
        xmin = Math.min(xmin, v[0][idx]);
        xmax = Math.max(xmax, v[0][idx]);
        ymin = Math.min(ymin, v[1][idx]);
        ymax = Math.max(ymax, v[1][idx]);
        zmin = Math.min(zmin, v[2][idx]);
        zmax = Math.max(zmax, v[2][idx]);
      }
      boxes[i - 1] = new double[]{xmin, xmax, ymin, ymax, zmin, zmax};
    }
    return boxes;
  }

  static int[] facesAtPlane(GeomSequence g, int axis, double value, double tol) {
    double[][] v = g.getVertexCoord();
    int[][] adj = g.getAdj(2, 0);
    ArrayList<Integer> out = new ArrayList<Integer>();
    for (int i = 1; i < adj.length; i++) {
      boolean ok = true;
      int count = 0;
      for (int k = 0; k < adj[i].length; k++) {
        int idx = adj[i][k] - 1;
        if (idx < 0) continue;
        count++;
        if (Math.abs(v[axis][idx] - value) > tol) {
          ok = false;
          break;
        }
      }
      if (ok && count >= 3) out.add(i);
    }
    int[] a = new int[out.size()];
    for (int i = 0; i < a.length; i++) a[i] = out.get(i);
    return a;
  }

  static int bigFaceAt(GeomSequence g, int axis, double value, double tol) {
    int[] f = facesAtPlane(g, axis, value, tol);
    return f.length > 0 ? f[0] : -1;
  }

  static void addAll(Set<Integer> set, int[] values) {
    for (int i = 0; i < values.length; i++) set.add(values[i]);
  }

  static ArrayNode assumptionsSlotLauncher(Model m) {
    ArrayNode a = OM.createArrayNode();
    a.add("3D cold electromagnetic model only; no plasma, gas flow or heat transfer is included.");
    a.add("Fused silica window is assumed lossless with epsr=3.8; metal walls are PEC; all other domains are air.");
    double offset = evalParam(m, "slot_offset");
    if (Math.abs(offset) > 1e-9) {
      a.add("The slot is offset from the broad-wall centerline to couple to the TE10 surface current.");
    } else {
      a.add("The slot is centred on the broad wall; this gives weak coupling to the TE10 surface current.");
    }
    if (evalParam(m, "ridge_h") > 0) {
      a.add("The ridge is a metal cutout under the slot, leaving a reduced-height gap to concentrate the electric field.");
    }
    a.add("Both waveguide ends use rectangular TE10 ports; port 2 is not excited.");
    a.add("A finite outer air box with scattering boundaries approximates the open half-space above the slot.");
    a.add("The field output is a cold-EM estimate; plasma ignition, density and uniformity require gas pressure, power and plasma data.");
    a.add("First-pass dimensions; mesh convergence and manufacturing tolerances have not been verified.");
    return a;
  }

  static void setDefaultParams(Model m, JsonNode p) throws Exception {
    setParamDefault(m, p, "r_in", "4.35");
    setParamDefault(m, p, "r_out", "10");
    setParamDefault(m, p, "z_feed", "20");
    setParamDefault(m, p, "z_tip", "60");
    setParamDefault(m, p, "r_tip_in", "0.5");
    setParamDefault(m, p, "r_tip_out", "6");
    setParamDefault(m, p, "freq", "2.45[GHz]");
    setParamDefault(m, p, "P_in", "1[W]");
    // Validate parameter expressions.
    String[] names = {"r_in", "r_out", "z_feed", "z_tip", "r_tip_in", "r_tip_out", "freq", "P_in"};
    for (int i = 0; i < names.length; i++) {
      m.param().evaluate(m.param().get(names[i]));
    }
  }

  static void setParamDefault(Model m, JsonNode p, String name, String defaultValue) {
    String v = p.has(name) ? p.get(name).asText() : defaultValue;
    m.param().set(name, v);
  }

  static double evalParam(Model m, String name) {
    return m.param().evaluate(m.param().get(name));
  }

  static void addAirMaterial(Model m) {
    Material mat = m.material().create("mat1", "Common");
    mat.label("Air (user-declared baseline)");
    mat.selection().set(new int[]{1});
    mat.propertyGroup("def").set("relpermittivity", "1");
    mat.propertyGroup("def").set("relpermeability", "1");
    mat.propertyGroup("def").set("electricconductivity", "0");
  }

  static void buildMesh(Model m, int dim, int hauto) {
    m.mesh().create("mesh1", "geom1");
    m.mesh("mesh1").feature().create("size1", "Size").set("hauto", hauto);
    if (dim == 2) m.mesh("mesh1").feature().create("ftri1", "FreeTri");
    else m.mesh("mesh1").feature().create("ftet1", "FreeTet");
    m.mesh("mesh1").run();
  }

  static int findEdgeByZ(GeomSequence g, double zTarget, double tol) {
    double[][] v = g.getVertex();
    double[][] e = g.getEdge();
    for (int i = 0; i < e[0].length; i++) {
      int a = (int) e[0][i] - 1;
      int b = (int) e[1][i] - 1;
      if (a >= 0 && b >= 0 && a < v[0].length && b < v[0].length
          && Math.abs(v[1][a] - zTarget) < tol && Math.abs(v[1][b] - zTarget) < tol) {
        return i + 1;
      }
    }
    return -1;
  }

  static ArrayNode assumptionsCoaxGap() {
    ArrayNode a = OM.createArrayNode();
    a.add("The air/vacuum gap is the only modeled domain; metal walls are represented by PEC boundaries, not solid domains.");
    a.add("The coaxial input port is a TEM port normalised to P_in at PortName 1; zref defaults to 50 ohm.");
    a.add("The conical outlet is an open scattering boundary, not a matched second port.");
    a.add("Air is a user-declared baseline material (epsr=1, mur=1, sigma=0); it is NOT a plasma model.");
    a.add("No gas flow, heat transfer or plasma physics is included in this template.");
    a.add("Geometry is a 2D axisymmetric idealisation; manufacturing tolerances and 3D asymmetry are not represented.");
    return a;
  }

  // ------------------------------------------------------------- evaluation

  static void evaluateOne(Model m, JsonNode req, ObjectNode row) throws Exception {
    String kind = req.path("kind").asText("global");
    row.put("kind", kind);
    JsonNode exprs = req.path("exprs");
    if (!exprs.isArray() || exprs.size() == 0) {
      throw new BridgeException("BAD_REQUEST", "exprs must be a non-empty string array");
    }
    String[] arr = new String[exprs.size()];
    for (int i = 0; i < arr.length; i++) arr[i] = exprs.get(i).asText();
    String dataset = text(req, "dataset");

    boolean axisym = isAxisymmetric(m);
    int dim = geometryDim(m);
    boolean interpolate = "point".equals(kind) || "line".equals(kind);
    String type = "global".equals(kind) ? "Global"
        : interpolate ? "Interp"
        : featureType(kind, dim, axisym);
    row.put("featureType", type);

    double[][] coords = null;
    if (interpolate) {
      coords = readCoords(req, kind);
      row.set("coordinates", matrixJson(coords));
    }

    ArrayNode values = row.putArray("values");
    int failed = 0;
    for (int e = 0; e < arr.length; e++) {
      ObjectNode v = values.addObject();
      v.put("expr", arr[e]);
      try {
        NumericalFeature nf = m.result().numerical().create(tag(interpolate ? "interp" : "eval"), type);
        nf.set("expr", new String[]{arr[e]});
        if (dataset != null) {
          if ("global".equals(kind)) safeSet(nf, "data", dataset);
          else nf.set("data", dataset);
        }
        if (interpolate) {
          nf.set("coorderr", "off");
          nf.set("coord", coords);
          double[][][] data = nf.getData();
          double[][][] imag = nf.getImagData();
          ArrayNode realRows = v.putArray("real");
          ArrayNode imagRows = v.putArray("imag");
          int nSol = data.length > 0 ? data[0].length : 0;
          for (int s = 0; s < nSol; s++) {
            realRows.add(doubleArray(data[0][s]));
            imagRows.add(doubleArray(imag.length > 0 ? imag[0][s] : new double[data[0][s].length]));
          }
        } else {
          if ("volume_integral".equals(kind) && dim == 2 && axisym) {
            nf.set("intvolume", "on");
          }
          if ("surface_integral".equals(kind) && dim == 2 && axisym) {
            nf.set("intsurface", "on");
          }
          applySelection(nf, req.path("selection"));
          double[][] real = nf.getReal();
          double[][] imag = nf.getImag();
          ArrayNode realRows = v.putArray("real");
          ArrayNode imagRows = v.putArray("imag");
          for (int s = 0; s < real.length; s++) {
            ArrayNode rr = OM.createArrayNode();
            rr.add(numberOrNull(real[s].length > 0 ? real[s][0] : Double.NaN));
            realRows.add(rr);
            ArrayNode ir = OM.createArrayNode();
            ir.add(numberOrNull(imag.length > s && imag[s].length > 0 ? imag[s][0] : 0.0));
            imagRows.add(ir);
          }
        }
        v.put("nData", nf.getNData());
        try { v.put("unit", nf.getString("unit")); } catch (Throwable t) { }
        v.put("ok", true);
      } catch (Throwable t) {
        failed++;
        v.put("ok", false);
        ObjectNode err = v.putObject("error");
        err.put("code", classify(t));
        err.put("message", safe(t.getMessage()));
        if ("global".equals(kind)) {
          err.put("hint",
              "Global evaluation supports global scalar quantities such as S-parameters. Field expressions such as ewfd.normE must be evaluated with an integral, average, maximum, minimum, point or line kind.");
        }
      }
    }
    row.put("ok", failed == 0);
    row.put("failedCount", failed);
  }

  static String featureType(String kind, int dim, boolean axisym) {
    boolean surfaceLike = "surface_integral".equals(kind) || "surface_average".equals(kind)
        || "surface_maximum".equals(kind) || "surface_minimum".equals(kind);
    if (surfaceLike) {
      if (dim == 3) {
        if (kind.endsWith("integral")) return "IntSurface";
        if (kind.endsWith("average")) return "AvSurface";
        if (kind.endsWith("maximum")) return "MaxSurface";
        return "MinSurface";
      }
      if (dim == 2) {
        if (kind.endsWith("integral")) return "IntLine";
        if (kind.endsWith("average")) return "AvLine";
        if (kind.endsWith("maximum")) return "MaxLine";
        return "MinLine";
      }
      throw new BridgeException("UNSUPPORTED_GEOMETRY", "Surface evaluation requires a 2D or 3D component");
    }
    // Domain evaluation.
    if (dim == 3) {
      if ("volume_integral".equals(kind)) return "IntVolume";
      if ("average".equals(kind) || "volume_average".equals(kind)) return "AvVolume";
      if ("maximum".equals(kind) || "volume_maximum".equals(kind)) return "MaxVolume";
      if ("minimum".equals(kind) || "volume_minimum".equals(kind)) return "MinVolume";
      throw new BridgeException("UNKNOWN_KIND", "Unknown evaluation kind: " + kind);
    }
    if (dim == 2) {
      if ("volume_integral".equals(kind)) return "IntSurface";
      if ("average".equals(kind) || "volume_average".equals(kind)) return "AvSurface";
      if ("maximum".equals(kind) || "volume_maximum".equals(kind)) return "MaxSurface";
      if ("minimum".equals(kind) || "volume_minimum".equals(kind)) return "MinSurface";
      throw new BridgeException("UNKNOWN_KIND", "Unknown evaluation kind: " + kind);
    }
    throw new BridgeException("UNSUPPORTED_GEOMETRY", "Unsupported geometry dimension: " + dim);
  }

  static double[][] readCoords(JsonNode req, String kind) {
    JsonNode c = req.path("coordinates");
    if (c.isArray() && c.size() > 0) {
      double[][] out = new double[c.size()][];
      for (int i = 0; i < c.size(); i++) {
        JsonNode p = c.get(i);
        out[i] = new double[p.size()];
        for (int j = 0; j < p.size(); j++) out[i][j] = p.get(j).asDouble();
      }
      return out;
    }
    if ("line".equals(kind)) {
      JsonNode start = req.path("start");
      JsonNode end = req.path("end");
      int n = Math.max(2, req.path("points").asInt(50));
      if (!start.isArray() || !end.isArray()) {
        throw new BridgeException("BAD_REQUEST", "line evaluation needs start and end coordinate arrays");
      }
      int d = start.size();
      double[][] pts = new double[d][n];
      for (int j = 0; j < d; j++) {
        double a = start.get(j).asDouble();
        double b = end.get(j).asDouble();
        for (int i = 0; i < n; i++) pts[j][i] = a + (b - a) * i / (n - 1.0);
      }
      return pts;
    }
    throw new BridgeException("BAD_REQUEST", "point evaluation needs a coordinates array");
  }

  // ---------------------------------------------------------------- exports

  static void exportSparameters(Model m, JsonNode item, ObjectNode row) throws Exception {
    String dir = required(item, "outputDir");
    String file = text(item, "filename");
    if (file == null) file = "s_parameters.csv";
    File out = new File(dir, file);
    ensureParent(out.getAbsolutePath());

    List<String> portNames = new ArrayList<String>();
    List<String> prefixes = new ArrayList<String>();
    String[] physTags = m.physics().tags();
    for (int i = 0; i < physTags.length; i++) {
      com.comsol.model.physics.Physics p = m.physics(physTags[i]);
      String[] fts = p.feature().tags();
      for (int j = 0; j < fts.length; j++) {
        if ("Port".equals(p.feature(fts[j]).getType())) {
          String pn = "1";
          try { pn = p.feature(fts[j]).getString("PortName"); } catch (Throwable t) { }
          portNames.add(pn);
          prefixes.add(p.identifier());
        }
      }
    }
    if (portNames.size() == 0) {
      throw new BridgeException("NO_PORTS", "No Port features found in the model");
    }
    List<String> exprs = new ArrayList<String>();
    List<String> cols = new ArrayList<String>();
    for (int i = 0; i < portNames.size(); i++) {
      for (int j = 0; j < portNames.size(); j++) {
        exprs.add(prefixes.get(i) + ".S" + portNames.get(i) + portNames.get(j));
        cols.add("S" + portNames.get(i) + portNames.get(j));
      }
    }

    List<String> okExprs = new ArrayList<String>();
    List<String> okCols = new ArrayList<String>();
    List<double[][]> okValues = new ArrayList<double[][]>();
    ArrayNode skipped = OM.createArrayNode();
    int rows = 0;
    for (int e = 0; e < exprs.size(); e++) {
      try {
        NumericalFeature nf = m.result().numerical().create(tag("sparam"), "Global");
        nf.set("expr", new String[]{exprs.get(e)});
        double[][][] c = nf.getComplex();
        int r = c[0].length;
        double[][] vals = new double[r][2];
        for (int s = 0; s < r; s++) {
          vals[s][0] = c[0][s][0];
          vals[s][1] = c[1][s][0];
        }
        okExprs.add(exprs.get(e));
        okCols.add(cols.get(e));
        okValues.add(vals);
        rows = Math.max(rows, r);
      } catch (Throwable t) {
        skipped.add(exprs.get(e) + ": " + safe(t.getMessage()));
      }
    }
    if (okCols.isEmpty()) {
      throw new BridgeException("SPARAMETER_EVALUATION_FAILED",
          "No S-parameter expression could be evaluated; the model may excite only one port");
    }

    List<String> header = new ArrayList<String>();
    header.add("solution_index");
    header.addAll(okCols);
    for (int e = 0; e < okCols.size(); e++) {
      header.add(okCols.get(e) + "_mag");
      header.add(okCols.get(e) + "_dB");
    }
    List<String[]> data = new ArrayList<String[]>();
    for (int s = 0; s < rows; s++) {
      String[] r = new String[header.size()];
      r[0] = String.valueOf(s + 1);
      for (int e = 0; e < okValues.size(); e++) {
        double[][] vals = okValues.get(e);
        double re = s < vals.length ? vals[s][0] : Double.NaN;
        double im = s < vals.length ? vals[s][1] : Double.NaN;
        r[e + 1] = formatDouble(re) + "+" + formatDouble(im) + "j";
        double mag = Math.hypot(re, im);
        r[1 + okCols.size() + 2 * e] = formatDouble(mag);
        r[2 + okCols.size() + 2 * e] = formatDouble(20.0 * Math.log10(Math.max(mag, 1e-30)));
      }
      data.add(r);
    }
    writeCsv(out, header, data);
    row.put("path", out.getAbsolutePath());
    row.put("rows", rows);
    row.set("columns", OM.valueToTree(header));
    row.put("ports", OM.valueToTree(portNames));
    row.put("expressions", OM.valueToTree(okExprs));
    if (skipped.size() > 0) row.set("skippedExpressions", skipped);
  }

  static void exportTable(Model m, JsonNode item, ObjectNode row) throws Exception {
    String dir = required(item, "outputDir");
    String file = text(item, "filename");
    if (file == null) file = "table.csv";
    File out = new File(dir, file);
    ensureParent(out.getAbsolutePath());
    JsonNode exprs = item.path("exprs");
    if (!exprs.isArray() || exprs.size() == 0) throw new BridgeException("BAD_REQUEST", "exprs required");
    String[] arr = new String[exprs.size()];
    for (int i = 0; i < arr.length; i++) arr[i] = exprs.get(i).asText();
    NumericalFeature nf = m.result().numerical().create(tag("table"), "Global");
    nf.set("expr", arr);
    double[][] real = nf.getReal();
    double[][] imag = nf.getImag();
    List<String> header = new ArrayList<String>();
    header.add("solution_index");
    for (int i = 0; i < arr.length; i++) {
      header.add(arr[i] + "_real");
      header.add(arr[i] + "_imag");
    }
    List<String[]> data = new ArrayList<String[]>();
    for (int s = 0; s < real.length; s++) {
      String[] r = new String[header.size()];
      r[0] = String.valueOf(s + 1);
      for (int e = 0; e < arr.length; e++) {
        r[1 + 2 * e] = formatDouble(real[s][e]);
        r[2 + 2 * e] = formatDouble(imag[s][e]);
      }
      data.add(r);
    }
    writeCsv(out, header, data);
    row.put("path", out.getAbsolutePath());
    row.put("rows", real.length);
    row.set("columns", OM.valueToTree(header));
  }

  static void exportSamples(Model m, JsonNode item, ObjectNode row) throws Exception {
    String dir = required(item, "outputDir");
    String file = text(item, "filename");
    if (file == null) file = "field_samples.csv";
    File out = new File(dir, file);
    ensureParent(out.getAbsolutePath());
    JsonNode exprs = item.path("exprs");
    if (!exprs.isArray() || exprs.size() == 0) throw new BridgeException("BAD_REQUEST", "exprs required");
    String[] arr = new String[exprs.size()];
    for (int i = 0; i < arr.length; i++) arr[i] = exprs.get(i).asText();
    double[][] coords = readCoords(item, "point");
    NumericalFeature nf = m.result().numerical().create(tag("samples"), "Interp");
    nf.set("expr", arr);
    String dataset = text(item, "dataset");
    if (dataset != null) nf.set("data", dataset);
    nf.set("coorderr", "off");
    nf.set("coord", coords);
    double[][][] data = nf.getData();
    double[][][] imag = nf.getImagData();
    List<String> header = new ArrayList<String>();
    for (int i = 0; i < coords.length; i++) header.add("c" + i);
    for (int e = 0; e < arr.length; e++) {
      header.add(arr[e] + "_real");
      header.add(arr[e] + "_imag");
    }
    List<String[]> rows = new ArrayList<String[]>();
    int nPoints = coords.length > 0 ? coords[0].length : 0;
    for (int p = 0; p < nPoints; p++) {
      String[] r = new String[header.size()];
      for (int i = 0; i < coords.length; i++) r[i] = formatDouble(coords[i][p]);
      for (int e = 0; e < arr.length; e++) {
        r[coords.length + 2 * e] = formatDouble(data[e].length > 0 ? data[e][0][p] : Double.NaN);
        r[coords.length + 2 * e + 1] = formatDouble(imag[e].length > 0 ? imag[e][0][p] : Double.NaN);
      }
      rows.add(r);
    }
    writeCsv(out, header, rows);
    row.put("path", out.getAbsolutePath());
    row.put("rows", rows.size());
    row.set("columns", OM.valueToTree(header));
  }

  static void exportLine(Model m, JsonNode item, ObjectNode row) throws Exception {
    item = item.deepCopy();
    ((ObjectNode) item).put("kind", "line");
    exportSamplesWithLine(m, item, row);
  }

  static void exportSamplesWithLine(Model m, JsonNode item, ObjectNode row) throws Exception {
    String dir = required(item, "outputDir");
    String file = text(item, "filename");
    if (file == null) file = "field_line.csv";
    File out = new File(dir, file);
    ensureParent(out.getAbsolutePath());
    JsonNode exprs = item.path("exprs");
    String[] arr = new String[exprs.size()];
    for (int i = 0; i < arr.length; i++) arr[i] = exprs.get(i).asText();
    double[][] coords = readCoords(item, "line");
    NumericalFeature nf = m.result().numerical().create(tag("line"), "Interp");
    nf.set("expr", arr);
    String dataset = text(item, "dataset");
    if (dataset != null) nf.set("data", dataset);
    nf.set("coorderr", "off");
    nf.set("coord", coords);
    double[][][] data = nf.getData();
    double[][][] imag = nf.getImagData();
    List<String> header = new ArrayList<String>();
    for (int i = 0; i < coords.length; i++) header.add("c" + i);
    for (int e = 0; e < arr.length; e++) {
      header.add(arr[e] + "_real");
      header.add(arr[e] + "_imag");
    }
    List<String[]> rows = new ArrayList<String[]>();
    int nPoints = coords.length > 0 ? coords[0].length : 0;
    for (int p = 0; p < nPoints; p++) {
      String[] r = new String[header.size()];
      for (int i = 0; i < coords.length; i++) r[i] = formatDouble(coords[i][p]);
      for (int e = 0; e < arr.length; e++) {
        r[coords.length + 2 * e] = formatDouble(data[e].length > 0 ? data[e][0][p] : Double.NaN);
        r[coords.length + 2 * e + 1] = formatDouble(imag[e].length > 0 ? imag[e][0][p] : Double.NaN);
      }
      rows.add(r);
    }
    writeCsv(out, header, rows);
    row.put("path", out.getAbsolutePath());
    row.put("rows", rows.size());
    row.set("columns", OM.valueToTree(header));
  }

  static void exportImage(Model m, JsonNode item, ObjectNode row) throws Exception {
    String dir = required(item, "outputDir");
    String expr = required(item, "expr");
    String filename = text(item, "filename");
    if (filename == null) filename = "field.png";
    String title = text(item, "title");
    File out = new File(dir, filename);
    ensureParent(out.getAbsolutePath());
    int dim = geometryDim(m);
    String pgType = dim == 3 ? "PlotGroup3D" : "PlotGroup2D";
    String pgTag = tag("pg");
    ResultFeature pg = m.result().create(pgTag, pgType);
    ResultFeature surf = pg.create(tag("surf"), "Surface");
    surf.set("expr", expr);
    pg.run();
    ExportFeature img = m.result().export().create(tag("img"), "Image");
    img.set("plotgroup", pgTag);
    img.set("imagetype", "png");
    img.set("pngfilename", out.getAbsolutePath());
    if (title != null) {
      try { img.set("title2d", title); } catch (Throwable t) { }
    }
    img.run();
    row.put("path", out.getAbsolutePath());
    row.put("exists", out.exists());
    row.put("sizeBytes", out.length());
    row.put("plotGroup", pgTag);
    row.put("expr", expr);
  }

  static void exportIntegral(Model m, JsonNode item, ObjectNode row) throws Exception {
    String dir = required(item, "outputDir");
    String file = text(item, "filename");
    if (file == null) file = "evaluation.csv";
    File out = new File(dir, file);
    ensureParent(out.getAbsolutePath());
    ObjectNode evalItem = ((ObjectNode) item).deepCopy();
    String evalKind = item.path("evalKind").asText("volume_integral");
    evalItem.put("kind", evalKind);
    if (!evalItem.has("exprs") && item.has("expr")) {
      ArrayNode ea = evalItem.putArray("exprs");
      ea.add(item.path("expr").asText());
    }
    ObjectNode evalRow = OM.createObjectNode();
    evaluateOne(m, evalItem, evalRow);
    if (!evalRow.path("ok").asBoolean(false)) {
      throw new BridgeException("EVALUATION_FAILED", "Integral export evaluation failed; see evaluation.failedCount");
    }
    JsonNode values = evalRow.path("values");
    List<String> header = new ArrayList<String>();
    header.add("expr");
    header.add("kind");
    header.add("solution_index");
    header.add("real");
    header.add("imag");
    List<String[]> data = new ArrayList<String[]>();
    for (int e = 0; e < values.size(); e++) {
      JsonNode v = values.get(e);
      JsonNode real = v.path("real");
      JsonNode imag = v.path("imag");
      for (int s = 0; s < real.size(); s++) {
        JsonNode rowVals = real.get(s);
        for (int k = 0; k < rowVals.size(); k++) {
          String[] r = new String[5];
          r[0] = v.path("expr").asText();
          r[1] = evalKind;
          r[2] = String.valueOf(s + 1);
          r[3] = formatDouble(rowVals.get(k).asDouble());
          r[4] = formatDouble(imag.get(s).get(k).asDouble());
          data.add(r);
        }
      }
    }
    writeCsv(out, header, data);
    row.put("path", out.getAbsolutePath());
    row.put("rows", data.size());
    row.set("evaluation", evalRow);
  }

  // -------------------------------------------------------------- summaries

  static ObjectNode modelSummary(Model m) {
    ObjectNode s = OM.createObjectNode();
    try { s.put("path", m.getFilePath()); } catch (Throwable t) { }
    try { s.put("version", m.getComsolVersion()); } catch (Throwable t) { }
    ObjectNode params = s.putObject("parameters");
    try {
      String[] names = m.param().varnames();
      for (int i = 0; i < names.length; i++) params.put(names[i], m.param().get(names[i]));
    } catch (Throwable t) { }

    ArrayNode geoms = s.putArray("geometries");
    try {
      String[] tags = m.geom().tags();
      for (int i = 0; i < tags.length; i++) {
        GeomSequence g = m.geom(tags[i]);
        ObjectNode o = geoms.addObject();
        o.put("tag", tags[i]);
        try { o.put("spaceDimension", g.getSDim()); } catch (Throwable t) { }
        try { o.put("axisymmetric", g.isAxisymmetric()); } catch (Throwable t) { }
        try { o.put("domains", g.getNDomains()); } catch (Throwable t) { }
        try { o.put("boundaries", g.getNBoundaries()); } catch (Throwable t) { }
        try { o.put("edges", g.getNEdges()); } catch (Throwable t) { }
        try { o.put("vertices", g.getNVertices()); } catch (Throwable t) { }
        try { o.put("lengthUnit", g.lengthUnit()); } catch (Throwable t) { }
        ArrayNode features = o.putArray("features");
        String[] fts = g.feature().tags();
        for (int j = 0; j < fts.length; j++) {
          GeomFeature f = g.feature(fts[j]);
          ObjectNode fo = features.addObject();
          fo.put("tag", fts[j]);
          try { fo.put("type", f.getType()); } catch (Throwable t) { }
          String fl = cleanLabel(f.label());
          if (fl != null) fo.put("label", fl);
        }
      }
    } catch (Throwable t) { }

    ArrayNode materials = s.putArray("materials");
    try {
      String[] tags = m.material().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = materials.addObject();
        o.put("tag", tags[i]);
        String ml = cleanLabel(m.material(tags[i]).label());
        if (ml != null) o.put("label", ml);
      }
    } catch (Throwable t) { }

    ArrayNode meshes = s.putArray("meshes");
    try {
      String[] tags = m.mesh().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = meshes.addObject();
        o.put("tag", tags[i]);
        try { o.put("numElements", m.mesh(tags[i]).getNumElem()); } catch (Throwable t) { }
        try { o.put("numVertices", m.mesh(tags[i]).getNumVertex()); } catch (Throwable t) { }
      }
    } catch (Throwable t) { }

    ArrayNode physics = s.putArray("physics");
    try {
      String[] tags = m.physics().tags();
      for (int i = 0; i < tags.length; i++) {
        com.comsol.model.physics.Physics p = m.physics(tags[i]);
        ObjectNode o = physics.addObject();
        o.put("tag", tags[i]);
        try { o.put("type", p.getType()); } catch (Throwable t) { }
        try { o.put("identifier", p.identifier()); } catch (Throwable t) { }
        String pl = cleanLabel(p.label());
        if (pl != null) o.put("label", pl);
        ArrayNode features = o.putArray("features");
        String[] fts = p.feature().tags();
        for (int j = 0; j < fts.length; j++) {
          ObjectNode fo = features.addObject();
          fo.put("tag", fts[j]);
          try { fo.put("type", p.feature(fts[j]).getType()); } catch (Throwable t) { }
          String pfl = cleanLabel(p.feature(fts[j]).label());
          if (pfl != null) fo.put("label", pfl);
        }
      }
    } catch (Throwable t) { }

    ArrayNode studies = s.putArray("studies");
    try {
      String[] tags = m.study().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = studies.addObject();
        o.put("tag", tags[i]);
        String sl = cleanLabel(m.study(tags[i]).label());
        if (sl != null) o.put("label", sl);
        ArrayNode steps = o.putArray("steps");
        String[] st = m.study(tags[i]).feature().tags();
        for (int j = 0; j < st.length; j++) {
          ObjectNode so = steps.addObject();
          so.put("tag", st[j]);
          try { so.put("type", m.study(tags[i]).feature(st[j]).getType()); } catch (Throwable t) { }
          String sfl = cleanLabel(m.study(tags[i]).feature(st[j]).label());
          if (sfl != null) so.put("label", sfl);
        }
      }
    } catch (Throwable t) { }

    ObjectNode results = s.putObject("results");
    ArrayNode datasets = results.putArray("datasets");
    try {
      String[] tags = m.result().dataset().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = datasets.addObject();
        o.put("tag", tags[i]);
        try { o.put("type", m.result().dataset(tags[i]).getType()); } catch (Throwable t) { }
      }
    } catch (Throwable t) { }
    ArrayNode numerical = results.putArray("numerical");
    try {
      String[] tags = m.result().numerical().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = numerical.addObject();
        o.put("tag", tags[i]);
        try { o.put("type", m.result().numerical(tags[i]).getType()); } catch (Throwable t) { }
      }
    } catch (Throwable t) { }
    ArrayNode exports = results.putArray("exports");
    try {
      String[] tags = m.result().export().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = exports.addObject();
        o.put("tag", tags[i]);
        try { o.put("type", m.result().export(tags[i]).getType()); } catch (Throwable t) { }
      }
    } catch (Throwable t) { }
    ArrayNode plots = results.putArray("plots");
    try {
      String[] tags = m.result().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = plots.addObject();
        o.put("tag", tags[i]);
        try { o.put("type", m.result(tags[i]).getType()); } catch (Throwable t) { }
      }
    } catch (Throwable t) { }

    s.set("solutions", solutionSummary(m));
    return s;
  }

  static ArrayNode solutionSummary(Model m) {
    ArrayNode solutions = OM.createArrayNode();
    try {
      String[] tags = m.sol().tags();
      for (int i = 0; i < tags.length; i++) {
        ObjectNode o = solutions.addObject();
        o.put("tag", tags[i]);
        try { o.put("size", OM.valueToTree(m.sol(tags[i]).getSize())); } catch (Throwable t) { }
      }
    } catch (Throwable t) { }
    return solutions;
  }

  // ------------------------------------------------------------------ helpers

  static Model loadModel(JsonNode job) throws Exception {
    String path = required(job, "modelPath");
    File f = new File(path);
    if (!f.exists()) throw new BridgeException("MODEL_NOT_FOUND", "Model file not found: " + path);
    if (!f.canRead()) throw new BridgeException("MODEL_NOT_READABLE", "Model file is not readable: " + path);
    String tag = ModelUtil.uniquetag("M");
    System.out.println("LOADING_MODEL=" + path);
    Model m = ModelUtil.load(tag, path);
    System.out.println("MODEL_LOADED=" + path);
    return m;
  }

  static ArrayNode applyParams(Model m, JsonNode params, boolean requireExisting) throws Exception {
    ArrayNode out = OM.createArrayNode();
    if (params == null || !params.isObject()) return out;
    Set<String> existing = new HashSet<String>();
    String[] names = m.param().varnames();
    for (int i = 0; i < names.length; i++) existing.add(names[i]);
    Iterator<String> it = params.fieldNames();
    while (it.hasNext()) {
      String name = it.next();
      String value = params.get(name).asText();
      ObjectNode row = OM.createObjectNode();
      row.put("name", name);
      if (!existing.contains(name)) {
        if (requireExisting) {
          throw new BridgeException("PARAM_NOT_FOUND", "Global parameter does not exist: " + name
              + "; available: " + existing);
        }
        row.put("existed", false);
      } else {
        row.put("existed", true);
        row.put("oldValue", m.param().get(name));
      }
      m.param().set(name, value);
      row.put("newValue", m.param().get(name));
      out.add(row);
    }
    return out;
  }

  static void applySelection(NumericalFeature nf, JsonNode sel) throws Exception {
    if (sel == null || sel.isMissingNode() || sel.isNull()) return;
    if (sel.isTextual()) {
      nf.selection().named(sel.asText());
      return;
    }
    if (sel.isArray()) {
      int[] ids = new int[sel.size()];
      for (int i = 0; i < ids.length; i++) ids[i] = sel.get(i).asInt();
      nf.selection().set(ids);
      return;
    }
    throw new BridgeException("BAD_REQUEST", "selection must be an integer array or a named selection");
  }

  static boolean isAxisymmetric(Model m) {
    try {
      String[] tags = m.geom().tags();
      return tags.length > 0 && m.geom(tags[0]).isAxisymmetric();
    } catch (Throwable t) {
      return false;
    }
  }

  static int geometryDim(Model m) {
    try {
      String[] tags = m.geom().tags();
      if (tags.length == 0) return 3;
      int sd = m.geom(tags[0]).getSDim();
      return sd > 0 ? sd : 3;
    } catch (Throwable t) {
      return 3;
    }
  }

  static void safeSet(NumericalFeature nf, String prop, String value) {
    try { nf.set(prop, value); } catch (Throwable t) { }
  }

  static String tag(String prefix) {
    TAG_SEQ++;
    return prefix + "_" + TAG_SEQ;
  }

  static String required(JsonNode node, String field) {
    String v = text(node, field);
    if (v == null || v.length() == 0) {
      throw new BridgeException("MISSING_FIELD", "Missing required field: " + field);
    }
    return v;
  }

  static String text(JsonNode node, String field) {
    JsonNode v = node.get(field);
    if (v == null || v.isNull() || v.isMissingNode()) return null;
    String s = v.asText();
    return s == null || s.length() == 0 ? null : s;
  }

  static boolean contains(String[] arr, String value) {
    for (int i = 0; i < arr.length; i++) if (arr[i].equals(value)) return true;
    return false;
  }

  static boolean samePath(String a, String b) {
    try {
      return new File(a).getCanonicalPath().equalsIgnoreCase(new File(b).getCanonicalPath());
    } catch (Throwable t) {
      return a.equalsIgnoreCase(b);
    }
  }

  static void ensureParent(String path) {
    File parent = new File(path).getParentFile();
    if (parent != null) parent.mkdirs();
  }

  static boolean equalTrim(String a, String b) {
    return a != null && b != null && a.trim().equals(b.trim());
  }

  static boolean closeEnough(double a, double b) {
    double scale = Math.max(Math.abs(a), Math.abs(b));
    if (scale == 0) return true;
    return Math.abs(a - b) / scale < 1e-9;
  }

  static String formatDouble(double v) {
    if (Double.isNaN(v)) return "";
    if (Double.isInfinite(v)) return v > 0 ? "Infinity" : "-Infinity";
    return String.format(Locale.ROOT, "%.12g", v);
  }

  static JsonNode numberOrNull(double v) {
    if (Double.isNaN(v)) return NullNode.getInstance();
    return DoubleNode.valueOf(v);
  }

  static ArrayNode doubleArray(double[] a) {
    ArrayNode out = OM.createArrayNode();
    for (int i = 0; i < a.length; i++) out.add(a[i]);
    return out;
  }

  static JsonNode matrixJson(double[][] m) {
    ArrayNode rows = OM.createArrayNode();
    for (int i = 0; i < m.length; i++) rows.add(doubleArray(m[i]));
    return rows;
  }

  static void writeCsv(File out, List<String> header, List<String[]> rows) throws IOException {
    ensureParent(out.getAbsolutePath());
    OutputStreamWriter w = new OutputStreamWriter(new FileOutputStream(out), "UTF-8");
    try {
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < header.size(); i++) {
        if (i > 0) sb.append(',');
        sb.append(csv(header.get(i)));
      }
      sb.append('\n');
      for (int r = 0; r < rows.size(); r++) {
        String[] row = rows.get(r);
        for (int i = 0; i < header.size(); i++) {
          if (i > 0) sb.append(',');
          sb.append(csv(i < row.length ? row[i] : ""));
        }
        sb.append('\n');
      }
      w.write(sb.toString());
    } finally {
      w.close();
    }
  }

  static String csv(String v) {
    if (v == null) return "";
    boolean needs = v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0;
    if (!needs) return v;
    return "\"" + v.replace("\"", "\"\"") + "\"";
  }

  static String cleanLabel(String s) {
    if (s == null) return null;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c < 32 || c == '\uFFFD') return null;
    }
    String trimmed = s.trim();
    return trimmed.length() == 0 ? null : trimmed;
  }

  static String versionNumber(String s) {
    if (s == null) return "";
    java.util.regex.Matcher m = java.util.regex.Pattern.compile("([0-9]+(\\.[0-9]+)+)").matcher(s);
    return m.find() ? m.group(1) : "";
  }

  static String safe(String s) {
    if (s == null) return "";
    return s.replace('\n', ' ').replace('\r', ' ');
  }

  static String stackTrace(Throwable t) {
    StringWriter sw = new StringWriter();
    t.printStackTrace(new PrintWriter(sw));
    return sw.toString();
  }

  static String firstLines(String s, int n) {
    String[] lines = s.split("\\r?\\n");
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < Math.min(n, lines.length); i++) {
      if (i > 0) sb.append('\n');
      sb.append(lines[i]);
    }
    return sb.toString();
  }

  static String classify(Throwable t) {
    if (t instanceof BridgeException) return ((BridgeException) t).code;
    String msg = safe(t.getMessage());
    String lower = msg.toLowerCase();
    if (lower.contains("preview")) return "MODEL_IS_APPLICATION_LIBRARY_PREVIEW";
    if (lower.contains("license") || msg.contains("许可")) return "LICENSE_ERROR";
    if (lower.contains("accesscontrol") || lower.contains("access denied")) return "FILE_ACCESS_DENIED";
    if (lower.contains("not found") || msg.contains("找不到")) return "FILE_NOT_FOUND";
    if (lower.contains("not converge") || msg.contains("收敛")) return "CONVERGENCE_ERROR";
    if (lower.contains("mesh") || msg.contains("网格")) return "MESH_ERROR";
    if (lower.contains("geometry") || msg.contains("几何")) return "GEOMETRY_ERROR";
    return "COMSOL_ERROR";
  }

  static class BridgeException extends RuntimeException {
    final String code;
    BridgeException(String code, String message) {
      super(message);
      this.code = code;
    }
  }
}
