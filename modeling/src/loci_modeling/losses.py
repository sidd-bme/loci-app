"""Instance-aware losses for foreground, boundaries, and centre offsets."""

from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import nn
from torch.nn import functional as F


@dataclass(frozen=True, slots=True)
class LossConfig:
    foreground_bce_weight: float = 1.0
    foreground_dice_weight: float = 1.0
    boundary_bce_weight: float = 0.6
    boundary_dice_weight: float = 0.4
    offset_weight: float = 1.0
    offset_huber_beta: float = 0.1


def _balanced_bce(logits: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    positives = target.sum().detach()
    negatives = target.numel() - positives
    positive_weight = torch.clamp(negatives / torch.clamp(positives, min=1.0), 1.0, 20.0)
    return F.binary_cross_entropy_with_logits(logits, target, pos_weight=positive_weight)


def _soft_dice_loss(
    logits: torch.Tensor, target: torch.Tensor, epsilon: float = 1e-6
) -> torch.Tensor:
    probability = torch.sigmoid(logits)
    dimensions = tuple(range(1, probability.ndim))
    intersection = (probability * target).sum(dim=dimensions)
    denominator = probability.sum(dim=dimensions) + target.sum(dim=dimensions)
    dice = (2.0 * intersection + epsilon) / (denominator + epsilon)
    return 1.0 - dice.mean()


class LociInstanceLoss(nn.Module):
    def __init__(self, config: LossConfig | None = None) -> None:
        super().__init__()
        self.config = config or LossConfig()

    def forward(
        self,
        prediction: torch.Tensor,
        target: torch.Tensor,
    ) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        if prediction.shape != target.shape or prediction.ndim != 4 or prediction.shape[1] != 4:
            raise ValueError("prediction and target must both have shape [batch,4,height,width]")
        foreground_target = target[:, 0]
        boundary_target = target[:, 1]
        foreground_bce = _balanced_bce(prediction[:, 0], foreground_target)
        foreground_dice = _soft_dice_loss(prediction[:, 0], foreground_target)
        boundary_bce = _balanced_bce(prediction[:, 1], boundary_target)
        boundary_dice = _soft_dice_loss(prediction[:, 1], boundary_target)

        predicted_offsets = torch.tanh(prediction[:, 2:4])
        target_offsets = target[:, 2:4]
        # Boundary pixels have ambiguous ownership; optimize offsets on instance interiors.
        interior = ((foreground_target > 0.5) & (boundary_target < 0.5)).unsqueeze(1)
        if interior.any():
            offset_error = F.smooth_l1_loss(
                predicted_offsets[interior.expand_as(predicted_offsets)],
                target_offsets[interior.expand_as(target_offsets)],
                beta=self.config.offset_huber_beta,
                reduction="mean",
            )
        else:
            offset_error = predicted_offsets.sum() * 0.0

        total = (
            self.config.foreground_bce_weight * foreground_bce
            + self.config.foreground_dice_weight * foreground_dice
            + self.config.boundary_bce_weight * boundary_bce
            + self.config.boundary_dice_weight * boundary_dice
            + self.config.offset_weight * offset_error
        )
        components = {
            "loss": total.detach(),
            "foreground_bce": foreground_bce.detach(),
            "foreground_dice": foreground_dice.detach(),
            "boundary_bce": boundary_bce.detach(),
            "boundary_dice": boundary_dice.detach(),
            "offset_huber": offset_error.detach(),
        }
        return total, components
