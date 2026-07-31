function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function harmonicMean(precision, recall) {
  if (precision === null || recall === null) return null;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
}

function validateInputs(manifest, results) {
  assertArray(manifest?.cases, "manifest.cases");
  assertArray(results?.runs, "results.runs");

  const caseIds = new Set();
  for (const benchmarkCase of manifest.cases) {
    if (!benchmarkCase?.id || caseIds.has(benchmarkCase.id)) {
      throw new Error(`benchmark case IDs must be non-empty and unique: ${benchmarkCase?.id || ""}`);
    }
    caseIds.add(benchmarkCase.id);
    assertArray(benchmarkCase.expectedFindings, `${benchmarkCase.id}.expectedFindings`);
  }

  const configuredEngines = manifest.engines ? new Set(manifest.engines) : null;
  const seenRuns = new Set();
  for (const run of results.runs) {
    if (!caseIds.has(run.caseId)) {
      throw new Error(`unknown benchmark case: ${run.caseId}`);
    }
    if (!run.engine || (configuredEngines && !configuredEngines.has(run.engine))) {
      throw new Error(`unknown benchmark engine: ${run.engine || ""}`);
    }
    const runKey = `${run.engine}\0${run.caseId}`;
    if (seenRuns.has(runKey)) {
      throw new Error(`duplicate benchmark run: ${run.engine}/${run.caseId}`);
    }
    seenRuns.add(runKey);
    if (!["completed", "blocked", "failed"].includes(run.status)) {
      throw new Error(`invalid benchmark run status: ${run.status}`);
    }
    assertArray(run.findings, `${run.engine}/${run.caseId}.findings`);
  }
}

function scoreEngine(engine, cases, runs) {
  const runsByCase = new Map(runs.filter((run) => run.engine === engine).map((run) => [run.caseId, run]));
  const incompleteCaseIds = cases
    .filter((benchmarkCase) => runsByCase.get(benchmarkCase.id)?.status !== "completed")
    .map((benchmarkCase) => benchmarkCase.id)
    .sort();

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const completedDurations = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let runsWithUsage = 0;
  let runsWithCost = 0;

  for (const benchmarkCase of cases) {
    const run = runsByCase.get(benchmarkCase.id);
    if (run?.status !== "completed") continue;

    const expectedIds = new Set(benchmarkCase.expectedFindings.map((finding) => finding.id));
    const detectedIds = new Set();

    for (const finding of run.findings) {
      assertArray(finding.matchedExpectedIds, `${engine}/${benchmarkCase.id} finding matchedExpectedIds`);
      let matchedNewExpectedFinding = false;
      for (const expectedId of finding.matchedExpectedIds) {
        if (!expectedIds.has(expectedId)) {
          throw new Error(`unknown expected finding ID: ${expectedId}`);
        }
        if (!detectedIds.has(expectedId)) {
          detectedIds.add(expectedId);
          truePositives += 1;
          matchedNewExpectedFinding = true;
        }
      }
      if (!matchedNewExpectedFinding) {
        falsePositives += 1;
      }
    }

    falseNegatives += expectedIds.size - detectedIds.size;

    if (Number.isFinite(run.durationMs)) {
      completedDurations.push(run.durationMs);
    }
    if (run.usage && Number.isFinite(run.usage.inputTokens) && Number.isFinite(run.usage.outputTokens)) {
      inputTokens += run.usage.inputTokens;
      outputTokens += run.usage.outputTokens;
      if (Number.isFinite(run.usage.costUsd)) {
        costUsd += run.usage.costUsd;
        runsWithCost += 1;
      }
      runsWithUsage += 1;
    }
  }

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1: harmonicMean(precision, recall),
    completedCases: cases.length - incompleteCaseIds.length,
    totalCases: cases.length,
    incompleteCaseIds,
    averageDurationMs: completedDurations.length > 0
      ? completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length
      : null,
    usage: {
      inputTokens,
      outputTokens,
      costUsd,
      measuredRuns: runsWithUsage,
      measuredCostRuns: runsWithCost,
    },
  };
}

export function scoreBenchmark(manifest, results) {
  validateInputs(manifest, results);
  const engineNames = manifest.engines
    ? [...manifest.engines]
    : [...new Set(results.runs.map((run) => run.engine))];
  const engines = Object.fromEntries(
    engineNames.map((engine) => [engine, scoreEngine(engine, manifest.cases, results.runs)]),
  );

  return {
    manifestVersion: manifest.version,
    comparable: engineNames.length > 0 &&
      Object.values(engines).every((engine) => engine.incompleteCaseIds.length === 0),
    engines,
  };
}

export function scoreFilterEffectiveness(manifest, pairedResults) {
  assertArray(pairedResults?.runs, "pairedResults.runs");

  const beforeRuns = [];
  const afterRuns = [];
  const rejectionsByReason = {};

  for (const run of pairedResults.runs) {
    assertArray(run.candidates, `${run.caseId}.candidates`);
    for (const candidate of run.candidates) {
      if (typeof candidate.kept !== "boolean") {
        throw new TypeError(`${run.caseId} candidate kept must be a boolean`);
      }
      if (!candidate.kept) {
        const reason = candidate.rejectionReason || "unknown";
        rejectionsByReason[reason] = (rejectionsByReason[reason] || 0) + 1;
      }
    }

    const common = { caseId: run.caseId, status: run.status };
    beforeRuns.push({ ...common, engine: "before-filter", findings: run.candidates });
    afterRuns.push({
      ...common,
      engine: "after-filter",
      findings: run.candidates.filter((candidate) => candidate.kept),
    });
  }

  const comparison = scoreBenchmark(
    { ...manifest, engines: ["before-filter", "after-filter"] },
    { runs: [...beforeRuns, ...afterRuns] },
  );
  const before = comparison.engines["before-filter"];
  const after = comparison.engines["after-filter"];

  return {
    comparable: comparison.comparable,
    before,
    after,
    effect: {
      falsePositivesRemoved: before.falsePositives - after.falsePositives,
      falsePositiveReductionRate: ratio(
        before.falsePositives - after.falsePositives,
        before.falsePositives,
      ),
      truePositivesRemoved: before.truePositives - after.truePositives,
      truePositiveRetentionRate: ratio(after.truePositives, before.truePositives),
      precisionDelta: before.precision === null || after.precision === null
        ? null
        : after.precision - before.precision,
      recallDelta: before.recall === null || after.recall === null
        ? null
        : after.recall - before.recall,
      rejectionsByReason: Object.fromEntries(
        Object.entries(rejectionsByReason).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  };
}

function formatMetric(value) {
  return value === null ? "-" : value.toFixed(3);
}

function formatRate(value) {
  return value === null ? "評価不能" : `${(value * 100).toFixed(1)}%`;
}

export function formatBenchmarkReport(score) {
  const lines = [
    "# AIレビュー基盤 比較結果",
    "",
    `比較状態: ${score.comparable ? "完了" : "未完了"}`,
    "",
    "| Engine | TP | FP | FN | Precision | Recall | F1 | Cases | Avg ms | Input tokens | Output tokens | Cost USD | Usage runs |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const [name, engine] of Object.entries(score.engines)) {
    lines.push(
      `| ${name} | ${engine.truePositives} | ${engine.falsePositives} | ${engine.falseNegatives} | ` +
      `${formatMetric(engine.precision)} | ${formatMetric(engine.recall)} | ${formatMetric(engine.f1)} | ` +
      `${engine.completedCases}/${engine.totalCases} | ${engine.averageDurationMs === null ? "-" : engine.averageDurationMs.toFixed(0)} | ` +
      `${engine.usage.measuredRuns === 0 ? "-" : engine.usage.inputTokens} | ` +
      `${engine.usage.measuredRuns === 0 ? "-" : engine.usage.outputTokens} | ` +
      `${engine.usage.measuredCostRuns === 0 ? "-" : engine.usage.costUsd.toFixed(4)} | ${engine.usage.measuredRuns} |`,
    );
  }

  const incomplete = Object.entries(score.engines)
    .filter(([, engine]) => engine.incompleteCaseIds.length > 0);
  if (incomplete.length > 0) {
    lines.push("", "## 未完了ケース", "");
    for (const [name, engine] of incomplete) {
      lines.push(`- ${name}: ${engine.incompleteCaseIds.join(", ")}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatFilterEffectivenessReport(score) {
  const lines = [
    "# Evidence filter 有効性",
    "",
    `比較状態: ${score.comparable ? "完了" : "未完了"}`,
    "",
    "| Variant | TP | FP | FN | Precision | Recall | F1 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| filter適用前 | ${score.before.truePositives} | ${score.before.falsePositives} | ${score.before.falseNegatives} | ${formatMetric(score.before.precision)} | ${formatMetric(score.before.recall)} | ${formatMetric(score.before.f1)} |`,
    `| filter適用後 | ${score.after.truePositives} | ${score.after.falsePositives} | ${score.after.falseNegatives} | ${formatMetric(score.after.precision)} | ${formatMetric(score.after.recall)} | ${formatMetric(score.after.f1)} |`,
    "",
    "| Effect | Value |",
    "| --- | ---: |",
    `| 誤検知削減数 | ${score.effect.falsePositivesRemoved} |`,
    `| 誤検知削減率 | ${formatRate(score.effect.falsePositiveReductionRate)} |`,
    `| 正解削除数 | ${score.effect.truePositivesRemoved} |`,
    `| 正解保持率 | ${formatRate(score.effect.truePositiveRetentionRate)} |`,
    `| Precision差分 | ${formatMetric(score.effect.precisionDelta)} |`,
    `| Recall差分 | ${formatMetric(score.effect.recallDelta)} |`,
  ];

  const rejectionEntries = Object.entries(score.effect.rejectionsByReason);
  if (rejectionEntries.length > 0) {
    lines.push("", "## 棄却理由", "");
    for (const [reason, count] of rejectionEntries) {
      lines.push(`- ${reason}: ${count}`);
    }
  }

  if (score.effect.truePositiveRetentionRate === null) {
    lines.push(
      "",
      "> 正解候補がfilter適用前から0件のため、正解を保持できるかは評価できません。",
    );
  }

  return `${lines.join("\n")}\n`;
}
