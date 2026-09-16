"""Compact residual U-Net used by Loci-native profiles."""

from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F

from .contracts import ModelConfig


def _normalization_groups(channels: int, requested: int) -> int:
    for groups in range(min(channels, requested), 0, -1):
        if channels % groups == 0:
            return groups
    return 1


class ConvNormAct(nn.Sequential):
    def __init__(self, in_channels: int, out_channels: int, groups: int) -> None:
        super().__init__(
            nn.Conv2d(in_channels, out_channels, kernel_size=3, padding=1, bias=False),
            nn.GroupNorm(_normalization_groups(out_channels, groups), out_channels),
            nn.SiLU(inplace=True),
        )


class ResidualBlock(nn.Module):
    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        groups: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.first = ConvNormAct(in_channels, out_channels, groups)
        self.second = nn.Sequential(
            nn.Conv2d(out_channels, out_channels, kernel_size=3, padding=1, bias=False),
            nn.GroupNorm(_normalization_groups(out_channels, groups), out_channels),
        )
        self.skip = (
            nn.Identity()
            if in_channels == out_channels
            else nn.Conv2d(in_channels, out_channels, kernel_size=1, bias=False)
        )
        self.dropout = nn.Dropout2d(dropout) if dropout else nn.Identity()
        self.activation = nn.SiLU(inplace=True)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        residual = self.skip(inputs)
        output = self.first(inputs)
        output = self.dropout(output)
        output = self.second(output)
        return self.activation(output + residual)


class DownBlock(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, groups: int, dropout: float) -> None:
        super().__init__()
        self.downsample = nn.Conv2d(in_channels, out_channels, kernel_size=3, stride=2, padding=1)
        self.block = ResidualBlock(out_channels, out_channels, groups, dropout)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        return self.block(self.downsample(inputs))


class UpBlock(nn.Module):
    def __init__(
        self,
        in_channels: int,
        skip_channels: int,
        out_channels: int,
        groups: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.project = nn.Conv2d(in_channels, out_channels, kernel_size=1)
        self.block = ResidualBlock(out_channels + skip_channels, out_channels, groups, dropout)

    def forward(self, inputs: torch.Tensor, skip: torch.Tensor) -> torch.Tensor:
        # CUDA bilinear backward is incompatible with strict deterministic
        # algorithms in the pinned PyTorch 2.1 Vanda environment. Nearest
        # upsampling keeps training reproducible and exports cleanly to ONNX.
        output = F.interpolate(inputs, size=skip.shape[-2:], mode="nearest")
        output = self.project(output)
        return self.block(torch.cat([output, skip], dim=1))


class LociResidualUNet(nn.Module):
    """Four-head network: foreground, boundary, centre offset-x, centre offset-y."""

    output_channels = ("foreground_logit", "boundary_logit", "offset_x", "offset_y")

    def __init__(self, config: ModelConfig | None = None) -> None:
        super().__init__()
        self.config = config or ModelConfig()
        self.config.validate()
        channels = [self.config.base_channels * (2**level) for level in range(self.config.depth)]
        groups = self.config.group_norm_groups
        dropout = self.config.dropout
        self.stem = ResidualBlock(self.config.in_channels, channels[0], groups, dropout)
        self.down_blocks = nn.ModuleList(
            DownBlock(channels[index], channels[index + 1], groups, dropout)
            for index in range(len(channels) - 1)
        )
        bottleneck_channels = channels[-1] * 2
        self.bottleneck_down = DownBlock(channels[-1], bottleneck_channels, groups, dropout)
        decoder: list[UpBlock] = []
        current_channels = bottleneck_channels
        for skip_channels in reversed(channels):
            decoder.append(
                UpBlock(
                    current_channels,
                    skip_channels,
                    skip_channels,
                    groups,
                    dropout,
                )
            )
            current_channels = skip_channels
        self.up_blocks = nn.ModuleList(decoder)
        self.head = nn.Sequential(
            ConvNormAct(channels[0], channels[0], groups),
            nn.Conv2d(channels[0], 4, kernel_size=1),
        )
        self._initialize()

    def _initialize(self) -> None:
        for module in self.modules():
            if isinstance(module, nn.Conv2d):
                nn.init.kaiming_normal_(module.weight, mode="fan_out", nonlinearity="relu")
                if module.bias is not None:
                    nn.init.zeros_(module.bias)
            elif isinstance(module, nn.GroupNorm):
                nn.init.ones_(module.weight)
                nn.init.zeros_(module.bias)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        if inputs.ndim != 4 or inputs.shape[1] != self.config.in_channels:
            raise ValueError(
                f"expected [batch,{self.config.in_channels},height,width], "
                f"got {tuple(inputs.shape)}"
            )
        skips = [self.stem(inputs)]
        for block in self.down_blocks:
            skips.append(block(skips[-1]))
        output = self.bottleneck_down(skips[-1])
        for block, skip in zip(self.up_blocks, reversed(skips), strict=True):
            output = block(output, skip)
        return self.head(output)


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())
