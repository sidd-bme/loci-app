"""Fixed dense inference graph for VisCy iPSC nucleus UNeXt2 (see dynacell_NOTICE.txt).

Module and parameter names are checkpoint keys. Training, masking, alternative
encoders, stochastic layers and configuration-based construction are excluded.
"""

from functools import partial

import torch
from torch import Tensor, nn
from torch.nn import functional as F


class _LayerNorm2d(nn.LayerNorm):
    def __init__(self, channels: int):
        super().__init__(channels, eps=1e-6)

    def forward(self, x: Tensor) -> Tensor:
        return super().forward(x.permute(0, 2, 3, 1)).permute(0, 3, 1, 2)


class _GlobalResponseNorm(nn.Module):
    def __init__(self, channels: int, channels_last: bool):
        super().__init__()
        self.weight = nn.Parameter(torch.empty(channels))
        self.bias = nn.Parameter(torch.empty(channels))
        self.channel_axis = -1 if channels_last else 1
        self.spatial_axes = (1, 2) if channels_last else (2, 3)
        self.affine_shape = (1, 1, 1, -1) if channels_last else (1, -1, 1, 1)

    def forward(self, x: Tensor) -> Tensor:
        magnitude = x.norm(p=2, dim=self.spatial_axes, keepdim=True)
        response = magnitude / (magnitude.mean(self.channel_axis, keepdim=True) + 1e-6)
        return x + torch.addcmul(
            self.bias.view(self.affine_shape), self.weight.view(self.affine_shape), x * response
        )


class _ResponseMLP(nn.Module):
    def __init__(self, channels: int, channels_last: bool):
        super().__init__()
        project = nn.Linear if channels_last else partial(nn.Conv2d, kernel_size=1)
        self.fc1 = project(channels, 4 * channels)
        self.grn = _GlobalResponseNorm(4 * channels, channels_last)
        self.fc2 = project(4 * channels, channels)

    def forward(self, x: Tensor) -> Tensor:
        return self.fc2(self.grn(F.gelu(self.fc1(x))))


class _Projection(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv3d = nn.Conv3d(1, 32, (5, 4, 4), stride=(5, 4, 4))
        # Stored by the publisher even though the fixed 15-plane profile uses conv3d.
        self.conv2d = nn.Conv2d(1, 96, 4, stride=4)
        self.norm = nn.LayerNorm(96)

    def forward(self, x: Tensor) -> Tensor:
        features = self.conv3d(x).flatten(1, 2)
        patches = features.flatten(2).transpose(1, 2)
        return self.norm(patches).transpose(1, 2).reshape(features.shape)


class _EncoderBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.dwconv = nn.Conv2d(channels, channels, 7, padding=3, groups=channels, bias=False)
        self.layernorm = nn.LayerNorm(channels)
        self.mlp = _ResponseMLP(channels, channels_last=True)

    def forward(self, x: Tensor) -> Tensor:
        patches = self.dwconv(x).flatten(2).transpose(1, 2)
        features = self.mlp(self.layernorm(patches).unsqueeze(1)).squeeze(1)
        return features.transpose(1, 2).reshape(x.shape) + x


class _DecoderBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.conv_dw = nn.Conv2d(channels, channels, 7, padding=3, groups=channels)
        self.norm = _LayerNorm2d(channels)
        self.mlp = _ResponseMLP(channels, channels_last=False)

    def forward(self, x: Tensor) -> Tensor:
        return self.mlp(self.norm(self.conv_dw(x))) + x


class _Stage(nn.Module):
    def __init__(self, downsample: nn.Module, blocks: nn.Sequential):
        super().__init__()
        self.downsample = downsample
        self.blocks = blocks

    def forward(self, x: Tensor) -> Tensor:
        return self.blocks(self.downsample(x))


class _Encoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.stem = _Projection()
        self.stages = nn.ModuleList()
        previous = 96
        for channels, depth in ((96, 3), (192, 3), (384, 9), (768, 3)):
            downsample = (
                nn.Identity()
                if channels == previous
                else nn.Sequential(
                    _LayerNorm2d(previous), nn.Conv2d(previous, channels, 2, stride=2)
                )
            )
            blocks = nn.Sequential(*(_EncoderBlock(channels) for _ in range(depth)))
            self.stages.append(_Stage(downsample, blocks))
            previous = channels

    def forward(self, x: Tensor) -> list[Tensor]:
        x = self.stem(x)
        features = []
        for stage in self.stages:
            x = stage(x)
            features.append(x)
        return features


class _UpStage(nn.Module):
    def __init__(self, merged: int, channels: int):
        super().__init__()
        self.conv = _Stage(
            nn.Sequential(_LayerNorm2d(merged), nn.Conv2d(merged, channels, 1)),
            nn.Sequential(_DecoderBlock(channels), _DecoderBlock(channels)),
        )

    def forward(self, x: Tensor, skip: Tensor) -> Tensor:
        return self.conv(torch.cat((F.pixel_shuffle(x, 2), skip), dim=1))


class _Decoder(nn.Module):
    def __init__(self):
        super().__init__()
        # At each scale concatenate the pixel-shuffled features with its encoder skip.
        self.decoder_stages = nn.ModuleList(
            [_UpStage(192 + 384, 384), _UpStage(96 + 192, 192), _UpStage(48 + 96, 240)]
        )

    def forward(self, features: list[Tensor]) -> Tensor:
        x = features[-1]
        for stage, skip in zip(self.decoder_stages, reversed(features[:-1]), strict=True):
            x = stage(x, skip)
        return x


class NuclearUNeXt2(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = _Encoder()
        self.decoder = _Decoder()

    def forward(self, x: Tensor) -> Tensor:
        planes = F.pixel_shuffle(self.decoder(self.encoder(x)), 4)
        return F.avg_pool2d(F.pad(planes, (3, 0, 3, 0)), 4, stride=1).unsqueeze(1)
