"""Lightweight operation names shared by CLI parsing and research execution."""

from __future__ import annotations

OPERATION_CATALOG = {
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
    "validate_recipe": {
        "mutates": False,
        "summary": "Validate an explicit processing/analysis recipe",
    },
    "preview_recipe": {
        "mutates": False,
        "summary": "Run a bounded preview without adopting a result",
    },
    "run_recipe": {"mutates": True, "summary": "Create an immutable derived image or label result"},
    "result": {"mutates": False, "summary": "Inspect exact revision and linked measurements"},
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


TASK_OPERATIONS = frozenset(
    {
        "run_recipe",
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
        "colocalisation_run",
    }
)
PREVIEW_OPERATIONS = frozenset(
    {
        "tissue_preview",
        "preview_recipe",
        "histology_preview",
        "model_preview",
        "registration_preview",
        "puncta_preview",
        "field_assay_preview",
    }
)
