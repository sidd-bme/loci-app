# Real fluorescence qualification V2 addendum

Version: `real-fluorescence-v2`; recorded 23 October 2026 at 11:39:04 UTC,
before sealed evaluation. The integration lead reports that no sealed outcomes
have been viewed. This is a transparent pretest amendment **after development**,
not the unchanged V1 protocol and not evidence of a qualification pass. Record
this addendum's SHA-256 with the frozen settings and exact execution identities
before opening sealed outcomes.

The original [V1 protocol](REAL_FLUORESCENCE_QUALIFICATION.md) remains unchanged,
SHA-256 `c8e574c7beee5108709cd92046b6b2ccde79ac0b9c7827cbe9dccac098c99bfa`.
Its ordinary metrics, evaluator and packet validator are not altered. The new
definitions cannot retroactively establish a V1 claim.

## Reason and development disclosure

Independent review confirmed a metric-definition gap: ordinary relative count
error divides by reference count and is undefined for an empty reference;
ordinary instance F1 is undefined when reference and prediction are both empty.
Three of the 147 eligible development fields have empty references. They were
retained throughout, including their false-positive predictions. The full-cohort
ordinary relative-error median was therefore undefined, and V1's finite count
gate remained unestablished. No empty field was excluded or imputed.

Five development variants were known before this amendment:

| Variant | Diameter / minimum area (pixels / pixels²) | Sensitivity | Median ordinary F1, IoU .50 | Supplemental: 144 nonempty-reference median relative count error |
| --- | --- | ---: | ---: | ---: |
| Baseline | 36 / 80 | 0 | 0.888889 | 0.119061 |
| A | 34 / 80 | 0 | 0.892617 | 0.109495 |
| B | 36 / 80 | 0.10 | 0.894231 | 0.116026 |
| C | 32 / 80 | 0 | 0.899225 | 0.093750 |
| D | 28 / 80 | 0 | 0.894231 | 0.082597 |

The count column describes only the 144 defined denominators; the three empty
reference fields remain in all 147-field distributions. It is not a filtered
primary pass. These are development observations, not sealed qualification.

The lead selected C: fluorescence mode, bright polarity, expected diameter 32
pixels, minimum area 80 pixels², sensitivity 0, smoothing 1 pixel, split touching
enabled and exclude border disabled. C retained higher development instance
agreement than D while its descriptive nonempty-reference median count error
was below 0.10. This is a disclosed development-based recipe decision, not a
qualification claim. Keep these settings fixed for all 47 eligible sealed fields.

## Added V2 count loss and qualification F1

For each field let `g` be the nonnegative integer reference count and `p` the
nonnegative integer predicted count. Preserve ordinary relative count error as
`abs(p-g)/g` when `g > 0`, and undefined (`None`/JSON `null`) when `g == 0`.
Add a distinct **extended relative count loss**:

| Condition | Extended loss | JSON representation |
| --- | --- | --- |
| `g > 0` | `abs(p-g)/g` | `{"status":"finite","value":number}` |
| `g == 0` and `p == 0` | 0 | `{"status":"finite","value":0}` |
| `g == 0` and `p > 0` | positive infinity | `{"status":"positive-infinity","value":null}` |

The infinity representation is explicit status plus a null value, never a
serialized `Infinity`, `NaN`, or an ordinary undefined error disguised as zero.
Order all 47 losses, including positive infinities after every finite loss. The
median is the 24th order statistic. The count gate passes only if that median is
finite and <= 0.10; an infinite median fails. Do not drop infinite-loss fields.

At each original IoU threshold, 0.50 and 0.75, preserve the ordinary F1
`2*TP/(2*TP+FP+FN)`, including its undefined value when both sets are empty.
Add a distinct **qualification F1** equal to ordinary F1 except that both-empty
reference and prediction sets receive 1, by an explicit perfect-empty-set
convention. An empty reference with a nonempty prediction still receives F1=0.
Matching, threshold inclusion and all TP/FP/FN definitions remain unchanged.

V2's primary BBBC039 metric targets are median qualification F1 at IoU 0.50
>= 0.85 and median extended relative count loss <= 0.10 across **all 47** eligible
fields. Report qualification F1 at both IoU thresholds. The numerical targets
are unchanged; the empty-set definitions are new and versioned. Never describe
the revised definitions as V1 or use them to retroqualify previous outcomes.

## Reporting and limits

Report V1 and V2 separately. If any ordinary relative error or F1 is undefined,
V1 is explicitly **unestablished**; retain its undefined values and field keys.
Report every field, TP/FP/FN totals at both thresholds, reference/predicted counts,
all zero-reference fields, both-empty fields and empty-reference false-positive
fields. No exclusions, denominator replacement, epsilon or ordinary-value
imputation is authorized. Preserve failures and full field distributions.

The median is not a guarantee of adequate background performance. For example,
24 perfectly accurate nonempty fields and 23 empty-reference fields with false
positives can pass both V2 median gates: median loss 0 and median qualification
F1 1. The 23 infinite losses and false positives must remain visible. Do not
claim background adequacy or broader generalization from those median targets.

The separate [summary helper](../scripts/qa/real_fluorescence_summary.py) accepts
existing independent-oracle metric dictionaries and explicit expected keys. It
checks integer counts, TP/FP/FN identities, exact ordinary relative-error/F1
formula consistency, unique complete cohorts, finite numbers and IoU records.
It reads no images, references, source files or frozen packets and mutates none.
Its metric summary alone does not qualify an app, workflow or scientific method.
The original independent numerical oracle, packet/source/export verification,
real packaged GUI and MCP journeys, persistence/review checks and exact candidate
identity gates remain necessary.

BBBC013 remains unchanged: development-selected DNA nuclei diameter 18 pixels /
minimum area 35 pixels², the fixed five-pixel raw GFP ring endpoint, masks,
boundary/ambiguity/empty/zero-ring exclusions, controls, well summaries and
acceptance targets. No sealed reference, C/D or G/H assay outcome is accessed by
this amendment. All other V1 boundaries and limitations continue to apply.
