"""Loci-owned fixed PlainConvUNet hierarchy for one exact PUMA checkpoint.

Semantics were reviewed against PUMA's pinned factory and the Apache-2.0
dynamic-network-architectures reference at
19f56442581461ca428b7ea5d79e81d672c8d5a1. No upstream Python code is imported.
Torch is supplied explicitly by the verified optional backend, never imported
while inspecting this module or the static tensor schema.

Architecture reference copyright 2022 Division of Medical Image Computing,
German Cancer Research Center (DKFZ), Heidelberg, Germany; Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). This adapted fixed implementation
removes dynamic configuration and upstream imports and adds exact state checks.
"""

from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any

WIDTHS = (32, 64, 128, 256, 512, 512, 512, 512)


@dataclass(frozen=True, slots=True)
class TensorSpec:
    shape: tuple[int, ...]
    canonical_key: str

    @property
    def stride(self) -> tuple[int, ...]:
        return tuple(math.prod(self.shape[index + 1 :]) for index in range(len(self.shape)))

    @property
    def nbytes(self) -> int:
        return math.prod(self.shape) * 4


def _build_schema() -> dict[str, TensorSpec]:
    schema: dict[str, TensorSpec] = {}

    def block(prefix: str, cin: int, cout: int) -> None:
        for field, shape, alias in (
            ("conv.weight", (cout, cin, 3, 3), "all_modules.0.weight"),
            ("conv.bias", (cout,), "all_modules.0.bias"),
            ("norm.weight", (cout,), "all_modules.1.weight"),
            ("norm.bias", (cout,), "all_modules.1.bias"),
        ):
            value = TensorSpec(shape, prefix + field)
            schema[prefix + field] = value
            schema[prefix + alias] = value

    for stage, width in enumerate(WIDTHS):
        previous = WIDTHS[stage - 1] if stage else 3
        for index in range(2):
            block(
                f"encoder.stages.{stage}.0.convs.{index}.", previous if index == 0 else width, width
            )
    for key, value in tuple(schema.items()):
        schema["decoder." + key] = value
    for stage, width in enumerate(reversed(WIDTHS[:-1])):
        below = WIDTHS[-1 - stage]
        for index in range(2):
            block(
                f"decoder.stages.{stage}.convs.{index}.", 2 * width if index == 0 else width, width
            )
        for key, shape in (
            (f"decoder.transpconvs.{stage}.weight", (below, width, 2, 2)),
            (f"decoder.transpconvs.{stage}.bias", (width,)),
            (f"decoder.seg_layers.{stage}.weight", (6, width, 1, 1)),
            (f"decoder.seg_layers.{stage}.bias", (6,)),
        ):
            schema[key] = TensorSpec(shape, key)
    return schema


STATE_SCHEMA = MappingProxyType(_build_schema())


def validate_state(torch: Any, state: Any, *, check: Any = None) -> dict[str, int | bool]:
    """Refuse anything except the exact finite Float32 CPU state and aliases."""
    if type(state) not in (dict, OrderedDict) or set(state) != set(STATE_SCHEMA):
        raise ValueError("PUMA state must contain exactly the 396 declared tensor keys")
    canonical_storages: dict[str, tuple[int, int]] = {}
    storage_owners: dict[tuple[int, int], str] = {}
    for key, spec in STATE_SCHEMA.items():
        if check is not None:
            check()
        value = state[key]
        if (
            type(value) is not torch.Tensor
            or value.dtype is not torch.float32
            or value.device.type != "cpu"
            or value.layout is not torch.strided
            or tuple(value.shape) != spec.shape
            or tuple(value.stride()) != spec.stride
            or value.storage_offset() != 0
            or value.is_conj()
            or value.is_neg()
        ):
            raise ValueError("PUMA tensor shape, dtype, device, layout or stride is unsupported")
        storage = value.untyped_storage()
        identity = (storage.data_ptr(), storage.nbytes())
        if identity[1] != spec.nbytes:
            raise ValueError("PUMA tensor storage length differs from its declared shape")
        if spec.canonical_key in canonical_storages:
            if canonical_storages[spec.canonical_key] != identity:
                raise ValueError("PUMA tensor aliases do not share the required storage")
        else:
            if identity in storage_owners:
                raise ValueError("Independent PUMA tensors unexpectedly share storage")
            if not bool(torch.isfinite(value).all().item()):
                raise ValueError("PUMA checkpoint contains nonfinite tensor values")
            canonical_storages[spec.canonical_key] = identity
            storage_owners[identity] = spec.canonical_key
    return {
        "tensor_keys": len(state),
        "unique_storages": len(storage_owners),
        "tensor_bytes": sum(size for _, size in storage_owners),
        "finite_values_checked": True,
        "aliases_checked": True,
    }


def make_network(torch: Any) -> Any:
    """Build only this fixed CPU/Float32 architecture; caller loads strict weights."""
    nn = torch.nn
    kwargs = {"device": "cpu", "dtype": torch.float32}

    class ConvNormActivation(nn.Module):
        def __init__(self, cin: int, cout: int, stride: int):
            super().__init__()
            self.conv = nn.Conv2d(cin, cout, 3, stride=stride, padding=1, bias=True, **kwargs)
            self.norm = nn.InstanceNorm2d(
                cout, eps=1e-5, affine=True, track_running_stats=False, momentum=0.1, **kwargs
            )
            self.nonlin = nn.LeakyReLU(negative_slope=0.01, inplace=True)
            # The checkpoint intentionally registers named and Sequential paths.
            self.all_modules = nn.Sequential(self.conv, self.norm, self.nonlin)

        def forward(self, value: Any) -> Any:
            return self.all_modules(value)

    class Stack(nn.Module):
        def __init__(self, cin: int, cout: int, stride: int):
            super().__init__()
            self.convs = nn.Sequential(
                ConvNormActivation(cin, cout, stride), ConvNormActivation(cout, cout, 1)
            )

        def forward(self, value: Any) -> Any:
            return self.convs(value)

    class Encoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.stages = nn.Sequential(
                *[
                    nn.Sequential(
                        Stack(3 if stage == 0 else WIDTHS[stage - 1], width, 1 if stage == 0 else 2)
                    )
                    for stage, width in enumerate(WIDTHS)
                ]
            )

        def forward(self, value: Any) -> list[Any]:
            skips = []
            for stage in self.stages:
                value = stage(value)
                skips.append(value)
            return skips

    class Decoder(nn.Module):
        def __init__(self, encoder: Any):
            super().__init__()
            self.encoder = encoder
            self.stages = nn.ModuleList()
            self.transpconvs = nn.ModuleList()
            self.seg_layers = nn.ModuleList()
            for stage, width in enumerate(reversed(WIDTHS[:-1])):
                self.transpconvs.append(
                    nn.ConvTranspose2d(WIDTHS[-1 - stage], width, 2, stride=2, bias=True, **kwargs)
                )
                self.stages.append(Stack(2 * width, width, 1))
                self.seg_layers.append(nn.Conv2d(width, 6, 1, bias=True, **kwargs))

        def forward(self, skips: list[Any]) -> Any:
            value = skips[-1]
            for index, stage in enumerate(self.stages):
                value = self.transpconvs[index](value)
                value = stage(torch.cat((value, skips[-2 - index]), dim=1))
            return self.seg_layers[-1](value)

    class Network(nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = Encoder()
            self.decoder = Decoder(self.encoder)

        def forward(self, value: Any) -> Any:
            return self.decoder(self.encoder(value))

    return Network()
