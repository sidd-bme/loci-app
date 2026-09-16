# Native model evaluation protocol

- **Version:** draft 0.1
- **Locked before:** any adjudicated final-test evaluation
- **Counting policy:** [draft 0.1](COUNTING_POLICY.md)

## Evidence levels

Loci keeps three evidence levels separate:

1. **Pseudo-label agreement** checks whether a development model reproduces the
   authorized historical Cellpose masks. It is useful for pipeline regression
   and model selection but is not accuracy.
2. **Adjudicated internal accuracy** uses acquisition-group-held-out images
   reviewed and corrected under the counting policy. This is the first evidence
   that can support an accuracy statement for the defined lab workflow.
3. **External workflow performance** uses images from independent labs or
   acquisition setups that were not used for model or threshold selection.

No metric may be promoted from a lower evidence level by changing its label in
the UI, model card, website, or release notes.

## Locked partitions

- The current 179/35/77 split is for pseudo-label development only.
- The 32 quarantined cases are challenge/review material, not automatic
  supervision.
- A final internal test batch must be selected by acquisition group before
  annotation review starts and remain untouched until the model, thresholds,
  and post-processing are frozen.
- Tiles, crops, augmentations, alternate masks, and repeated acquisitions from
  one source or experiment may never cross partitions.
- External beta images remain external holdouts; failed cases are not moved into
  training until the evaluated version has been closed and recorded.

## Reference review

The internal accuracy set should contain at least 100 images spanning at least
three independent acquisition groups and the supported density/contrast range.
Every image receives researcher review; a second reviewer adjudicates all
uncertain clusters and a random 20% of remaining images. The model never sees
the adjudicated test masks during selection.

Viability uncertainty, border truncation, focus uncertainty, cluster ambiguity,
and excluded debris/artifact are retained as stratification flags. Ordinary
brightfield appearance alone is not accepted as a definitive live/dead label.

## Metrics

Report per image, acquisition group, density quartile, and relevant uncertainty
stratum:

- count error, absolute error, absolute percentage error, and signed percentage
  bias;
- instance precision, recall, and F1 at IoU 0.50;
- average precision at IoU 0.50 and 0.75;
- split and merge errors per 100 reference instances;
- border-instance recall and false-positive rate;
- invalid/abstained-result rate;
- runtime and peak resident memory on the minimum supported Mac.

Percentage count metrics exclude a zero-reference image and report that image
separately. Confidence intervals use acquisition-group-aware bootstrap resampling,
not cell instances as independent samples.

## Proposed v1 acceptance gates

These thresholds apply only inside the declared supported acquisition domain:

| Gate | Acceptance threshold |
| --- | ---: |
| Median per-image absolute percentage count error | <= 5% |
| 90th percentile absolute percentage count error | <= 15% |
| Absolute aggregate signed count bias | <= 3% |
| Instance F1 at IoU 0.50 | >= 0.85 |
| Instance AP at IoU 0.50 | >= 0.75 |
| Combined split and merge errors | <= 8 per 100 reference instances |
| Border-instance recall | >= 0.80 |
| Structurally invalid result presented as usable | 0 cases |
| Unsupported/corrupt input with silent plausible count | 0 cases |

No acquisition group or density quartile may have a median absolute percentage
count error above 10%. If a subgroup misses the gate, the supported-domain
statement must narrow or the model must abstain reliably; an overall average
cannot hide it.

## Engineering gates

- CPU inference is the numerical reference.
- On the minimum supported Apple-silicon Mac, a 3,088 x 2,076 image must complete
  within 30 seconds median and remain within a 2.5 GiB peak resident-memory
  envelope during a sequential batch.
- Repeated CPU runs on fixed fixtures must produce identical integer labels and
  counts.
- CoreML acceleration remains disabled unless every release fixture has exact
  count parity with CPU and instance-mask IoU of at least 0.995 after label
  matching.
- Tiled inference must include seam-focused fixtures; no tile boundary may be
  visible as a systematic split, merge, or missing-cell band.
- Cancellation, model-hash failure, out-of-memory handling, and interrupted
  model-pack publication must fail without leaving a usable-looking partial
  result.

## Decision rule

The final test is run once after the model and thresholds are frozen. Passing
pseudo-label agreement is never sufficient for release. If an adjudicated gate
fails, Loci either narrows the supported domain, improves the pipeline using
training/validation evidence only, or remains a free beta. The failed locked
test version and its metrics stay in the model history.
