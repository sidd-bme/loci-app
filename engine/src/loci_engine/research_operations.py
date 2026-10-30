"""Lightweight operation names shared by CLI parsing and research execution."""

from __future__ import annotations

OPERATION_CATALOG = {
    "task_preview_get": {
        "mutates": False,
        "summary": "Inspect an exact retained durable preview without recomputation",
    },
    "sample_sheet_template": {
        "mutates": False,
        "summary": "Inspect a stable source-ID sample CSV template",
    },
    "sample_sheet_preview": {
        "mutates": False,
        "summary": "Validate exact sample CSV changes before applying",
    },
    "sample_sheet_apply": {
        "mutates": True,
        "summary": "Apply one current sample CSV preview atomically",
    },
    "intensity_catalog": {
        "mutates": False,
        "summary": "Inspect stored raw mean-intensity endpoints",
    },
    "intensity_preview": {
        "mutates": False,
        "summary": "Preview equal image and declared replicate intensity means",
    },
    "intensity_save": {"mutates": True, "summary": "Save an immutable exact intensity comparison"},
    "intensity_get": {
        "mutates": False,
        "summary": "Reopen a saved intensity comparison without recomputation",
    },
    "intensity_list": {"mutates": False, "summary": "List saved intensity comparisons"},
    "intensity_export": {
        "mutates": False,
        "summary": "Publish a saved intensity report through a private grant",
    },
    "remote_analysis_cancel": {
        "mutates": True,
        "summary": "Cancel a remote analysis bound to the current study",
    },
    "remote_analysis_plan": {
        "mutates": False,
        "summary": "Inspect an exact normal-analysis transfer and compute plan",
    },
    "remote_analysis_start": {
        "mutates": True,
        "summary": "Start one authorized normal analysis on a saved compute target",
    },
    "remote_analysis_advance": {
        "mutates": True,
        "summary": "Recover or advance one authorized remote analysis step",
    },
    "action_guide": {
        "mutates": False,
        "summary": "Discover shared research action schemas and execution contracts",
    },
    "describe_result": {
        "mutates": False,
        "summary": "Inspect saved analysis context for an exact result revision",
    },
    "review_history": {
        "mutates": False,
        "summary": "Read the ordered revision-bound review decisions",
    },
    "labels_import": {
        "mutates": True,
        "summary": "Adopt a checked external scalar TIFF label plane on its declared native grid",
    },
    "workflow_validate": {"mutates": False, "summary": "Validate a typed linear workflow"},
    "workflow_save": {"mutates": True, "summary": "Save a source-independent workflow revision"},
    "workflow_list": {"mutates": False, "summary": "List saved visual workflows"},
    "workflow_get": {"mutates": False, "summary": "Inspect an exact saved workflow"},
    "workflow_preflight": {
        "mutates": False,
        "summary": "Validate exact workflow/source bindings and resources",
    },
    "workflow_preview": {"mutates": False, "summary": "Preview a typed workflow processing prefix"},
    "workflow_run": {
        "mutates": True,
        "summary": "Publish a durable workflow result and run receipt",
    },
    "workflow_status": {
        "mutates": False,
        "summary": "Inspect exact workflow run review and export state",
    },
    "puncta_preview": {
        "mutates": False,
        "summary": "Preview declared bright-blob candidates on an explicit physical grid",
    },
    "puncta_run": {
        "mutates": True,
        "summary": "Adopt puncta candidates with raw intensities, scale, controls and assumptions",
    },
    "associate_results": {
        "mutates": True,
        "summary": "Associate exact declared nucleus and cell revisions with overlap ambiguity",
    },
    "spatial_distance_run": {
        "mutates": True,
        "summary": "Measure physical distance bands and sampled compartment density on exact masks",
    },
    "perinuclear_run": {
        "mutates": True,
        "summary": "Measure raw nuclear-to-perinuclear-ring enrichment on an exact native 2D grid",
    },
    "colocalisation_run": {
        "mutates": True,
        "summary": "Persist descriptive raw-channel correlation and thresholded Manders measures",
    },
    "field_assay_preview": {
        "mutates": False,
        "summary": "Preview nuclear segmentation, effective mask and field metrics",
    },
    "field_assay_run": {
        "mutates": True,
        "summary": "Adopt reviewed field assay with signed integral and provenance",
    },
    "batch_channel_colors": {
        "mutates": True,
        "summary": "Apply channel colors across selected or all loaded sources",
    },
    "surface_view": {
        "mutates": False,
        "summary": "Inspect a bounded display isosurface in calibrated world coordinates",
    },
    "channel_metadata": {
        "mutates": False,
        "summary": "Inspect original acquisition names and explicit channel declarations",
    },
    "channels": {
        "mutates": True,
        "summary": "Save declared channel identities independently of display or raw metadata",
    },
    "registration_preview": {
        "mutates": False,
        "summary": "Estimate a physical transform with exact result bindings and quality gates",
    },
    "registration_run": {
        "mutates": True,
        "summary": "Adopt only an exact registration preview into a derived output grid",
    },
    "resample_grid": {
        "mutates": True,
        "summary": "Crop and resample an immutable result onto a declared physical grid",
    },
    "track_results": {
        "mutates": True,
        "summary": "Track exact timed object revisions with explicit missing observations",
    },
    "tracking_result": {
        "mutates": False,
        "summary": "Inspect temporal associations, uncertainty and trajectories",
    },
    "correct_tracks": {
        "mutates": True,
        "summary": "Correct temporal associations in a new immutable revision",
    },
    "correction_info": {
        "mutates": False,
        "summary": "Inspect the exact label revision for editing",
    },
    "correct_result": {
        "mutates": True,
        "summary": "Correct labels and recompute measurements in a new revision",
    },
    "roi_add": {
        "mutates": True,
        "summary": "Add a calibrated source-intensity ROI in a new revision",
    },
    "roi_import": {
        "mutates": True,
        "summary": "Import exact-grid GeoJSON or ImageJ polygon annotations into a new revision",
    },
    "select_result": {
        "mutates": True,
        "summary": "Persist an existing result selection for undo or redo",
    },
    "model_list": {
        "mutates": False,
        "summary": "Inspect explicitly imported project model packages",
    },
    "model_preview": {
        "mutates": True,
        "summary": "Qualify a source-chosen preview before model adoption",
    },
    "model_run": {"mutates": True, "summary": "Adopt only an exact verified model preview"},
    "classical_run": {
        "mutates": True,
        "summary": "Run the established adaptive 2D baseline on an exact selected source plane",
    },
    "cellpose_run": {
        "mutates": True,
        "summary": "Run an exact provisioned Cellpose profile on a selected 2D source plane",
    },
    "study_summary": {
        "mutates": False,
        "summary": "Summarize declared biological replicates using exact result revisions",
    },
    "study_compare": {
        "mutates": True,
        "summary": (
            "Compare and save two compatible reviewed runs without treating objects as independent"
        ),
    },
    "study_correction_effect": {
        "mutates": True,
        "summary": "Save exact paired correction effects with equal biological-replicate weighting",
    },
    "tissue_preview": {
        "mutates": False,
        "summary": "Preview a declared bounded tissue-region mask",
    },
    "tissue_run": {
        "mutates": True,
        "summary": "Create calibrated tissue-region masks and measurements",
    },
    "histology_preview": {
        "mutates": False,
        "summary": "Preview a declared stain separation and region analysis",
    },
    "histology_run": {
        "mutates": True,
        "summary": "Adopt a declared stain analysis on a bounded native slide region",
    },
    "inspect": {"mutates": False, "summary": "Inspect registered native geometry and capabilities"},
    "view": {"mutates": False, "summary": "Render selected biological channels/plane or region"},
    "volume_view": {"mutates": False, "summary": "Linked orthogonal and bounded volume display"},
    "recipe_preflight": {
        "mutates": False,
        "summary": "Preflight recipe resource estimation and validation without executing",
    },
    "validate_recipe": {
        "mutates": False,
        "summary": "Validate an explicit processing/analysis recipe",
    },
    "preview_recipe": {
        "mutates": False,
        "summary": "Run a bounded preview without adopting a result",
    },
    "run_recipe": {"mutates": True, "summary": "Create an immutable derived image or label result"},
    "large_components_preflight": {
        "mutates": False,
        "summary": "Validate a bounded large scalar analysis",
    },
    "large_components_run": {
        "mutates": True,
        "summary": "Segment a calibrated plane with global component identity",
    },
    "large_result_view": {
        "mutates": False,
        "summary": "Inspect a bounded region of a large result",
    },
    "large_result_pick": {
        "mutates": False,
        "summary": "Read a native label and quantitative object",
    },
    "large_result_locate": {
        "mutates": False,
        "summary": "Find an actual native pixel of an exact quantitative object",
    },
    "large_result_delete": {
        "mutates": True,
        "summary": "Remove one complete object in an immutable revision",
    },
    "large_result_adopt": {
        "mutates": True,
        "summary": "Verify and adopt an uncorrected large-components result bundle",
    },
    "scientific_data_export": {
        "mutates": False,
        "summary": "Publish a planned scientific CSV package through a private destination grant",
    },
    "large_result_export": {
        "mutates": False,
        "summary": "Stream reviewed large result to an absent destination directory",
    },
    "result": {"mutates": False, "summary": "Inspect exact revision and linked measurements"},
    "population_locate": {
        "mutates": False,
        "summary": "Find the nearest owned pixel of an exact measured object",
    },
    "population_query": {
        "mutates": False,
        "summary": "Explore a bounded exact object population with descriptive metrics",
    },
    "result_view": {"mutates": False, "summary": "Render an exact derived image or label revision"},
    "result_label_at": {
        "mutates": False,
        "summary": "Lookup the exact discrete integer label at a result pixel coordinate",
    },
    "sample": {"mutates": True, "summary": "Set explicit study/sample/replicate metadata"},
    "display": {
        "mutates": True,
        "summary": "Save display mapping separately from scientific input",
    },
    "recipe": {
        "mutates": True,
        "summary": "Save a reusable validated recipe with optimistic revision",
    },
    "colocalisation": {
        "mutates": False,
        "summary": "Declared descriptive two-channel spatial association",
    },
}


for _remote_name, _remote_summary in {
    "profile_save": "Save a declared SSH connection, host key and resource policy",
    "profile_list": "List saved remote connections with private paths redacted",
    "profile_test": "Verify an explicitly configured SSH host identity",
    "readiness": "Verify the configured remote worker runtime and permitted roots",
    "run_list": "Inspect persisted remote run identities and recovery states",
    "stage": "Stage only the exact sources covered by explicit transfer authority",
    "submit": "Submit one staged request without duplicating a recovered job",
    "status": "Reconnect and inspect the exact server job identity",
    "cancel": "Cancel the explicitly selected server job",
    "retrieve": "Retrieve and verify an explicitly authorized result archive",
    "attach": "Validate and atomically attach unreviewed remote results",
    "logs": "Read bounded path-redacted logs from an exact remote run",
    "remove_owned": "Remove only verified Loci-owned remote run files after exact attachment",
}.items():
    OPERATION_CATALOG["remote_" + _remote_name] = {
        "mutates": _remote_name not in {"profile_list", "run_list", "logs"},
        "summary": _remote_summary,
    }


for _name, _mutates, _summary in (
    ("exploration_list", False, "List saved source-bound parameter comparisons"),
    ("exploration_get", False, "Read an exact saved parameter comparison record"),
    ("exploration_preview", False, "Preview bounded unsaved classical settings on an exact ROI"),
    ("exploration_compare", True, "Compare bounded ROIs/settings and retain the context receipt"),
    ("exploration_run", True, "Adopt exact preview settings as a provenance-bound result"),
    (
        "population_gate_evaluate",
        False,
        "Evaluate a rectangle or polygon against every measurement row",
    ),
    ("population_group_save", True, "Save immutable exact-revision population membership"),
    ("population_group_list", False, "List durable population groups"),
    ("population_group_get", False, "Verify exact saved population membership"),
    ("population_group_export", False, "Export a saved group as exact server-canonical JSON"),
    ("population_gate_export", False, "Export exact evaluated gate membership JSON"),
    ("population_gate_apply", True, "Evaluate a saved gate on a compatible result as a new group"),
    ("population_group_combine", True, "Save union, intersection or unclassified membership"),
):
    OPERATION_CATALOG[_name] = {"mutates": _mutates, "summary": _summary}


TASK_OPERATIONS = frozenset(
    {
        "workflow_run",
        "exploration_preview",
        "exploration_compare",
        "exploration_run",
        "workflow_preview",
        "run_recipe",
        "labels_import",
        "large_components_run",
        "large_result_delete",
        "large_result_adopt",
        "large_result_export",
        "scientific_data_export",
        "intensity_export",
        "preview_recipe",
        "histology_run",
        "histology_preview",
        "tissue_preview",
        "tissue_run",
        "model_run",
        "cellpose_run",
        "classical_run",
        "model_preview",
        "correct_result",
        "roi_add",
        "roi_import",
        "track_results",
        "correct_tracks",
        "registration_preview",
        "registration_run",
        "resample_grid",
        "puncta_preview",
        "puncta_run",
        "field_assay_preview",
        "field_assay_run",
        "associate_results",
        "perinuclear_run",
        "spatial_distance_run",
        "colocalisation_run",
    }
)
PREVIEW_OPERATIONS = frozenset(
    {
        "exploration_preview",
        "exploration_compare",
        "workflow_preview",
        "tissue_preview",
        "preview_recipe",
        "histology_preview",
        "model_preview",
        "registration_preview",
        "puncta_preview",
        "field_assay_preview",
    }
)
