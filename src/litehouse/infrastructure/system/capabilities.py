from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

GIB = 1024**3


class OperatingSystem(StrEnum):
    MACOS = "macos"
    LINUX = "linux"
    WINDOWS = "windows"
    UNKNOWN = "unknown"


class MemoryArchitecture(StrEnum):
    UNIFIED = "unified"
    DISCRETE = "discrete"
    SYSTEM_ONLY = "system_only"
    UNKNOWN = "unknown"


class AcceleratorKind(StrEnum):
    APPLE_GPU = "apple_gpu"
    NVIDIA_GPU = "nvidia_gpu"
    AMD_GPU = "amd_gpu"
    GENERIC_GPU = "generic_gpu"
    NONE = "none"
    UNKNOWN = "unknown"


class InferenceBackend(StrEnum):
    LLAMA_CPU = "llama_cpu"
    LLAMA_METAL = "llama_metal"
    LLAMA_CUDA = "llama_cuda"
    LLAMA_HIP = "llama_hip"
    LLAMA_VULKAN = "llama_vulkan"
    DIRECTML = "directml"


@dataclass(frozen=True, slots=True)
class CapabilityProfile:
    operating_system: OperatingSystem
    architecture: str
    logical_cpu_count: int
    total_ram_bytes: int
    available_ram_bytes: int
    disk_free_bytes: int
    memory_architecture: MemoryArchitecture
    accelerator: AcceleratorKind
    accelerator_memory_bytes: int | None
    available_backends: tuple[InferenceBackend, ...]
    estimated_safe_model_bytes: int

    def __post_init__(self) -> None:
        positive_fields = {
            "logical_cpu_count": self.logical_cpu_count,
            "total_ram_bytes": self.total_ram_bytes,
        }
        for name, value in positive_fields.items():
            if value <= 0:
                raise ValueError(f"{name} must be positive")
        if not 0 <= self.available_ram_bytes <= self.total_ram_bytes:
            raise ValueError("available_ram_bytes must be within total RAM")
        if self.disk_free_bytes < 0:
            raise ValueError("disk_free_bytes must not be negative")
        if self.accelerator_memory_bytes is not None and self.accelerator_memory_bytes <= 0:
            raise ValueError("accelerator_memory_bytes must be positive when known")
        memory_limit = self.total_ram_bytes
        if (
            self.memory_architecture is MemoryArchitecture.DISCRETE
            and self.accelerator_memory_bytes is not None
        ):
            memory_limit = max(memory_limit, self.accelerator_memory_bytes)
        if not 0 <= self.estimated_safe_model_bytes <= memory_limit:
            raise ValueError("estimated_safe_model_bytes exceeds a usable memory pool")
        if InferenceBackend.LLAMA_CPU not in self.available_backends:
            raise ValueError("the CPU backend must always be available")


def estimate_safe_model_budget(
    *,
    total_ram_bytes: int,
    available_ram_bytes: int,
    memory_architecture: MemoryArchitecture,
    accelerator_memory_bytes: int | None = None,
) -> int:
    if total_ram_bytes <= 0:
        raise ValueError("total_ram_bytes must be positive")
    if not 0 <= available_ram_bytes <= total_ram_bytes:
        raise ValueError("available_ram_bytes must be within total RAM")
    if accelerator_memory_bytes is not None and accelerator_memory_bytes <= 0:
        raise ValueError("accelerator_memory_bytes must be positive when known")

    operating_reserve = max(2 * GIB, total_ram_bytes // 5)
    system_budget = min(
        total_ram_bytes * 65 // 100,
        max(0, available_ram_bytes - operating_reserve),
    )

    # Unified memory is the system pool, so accelerator memory must never be added again.
    if memory_architecture is MemoryArchitecture.UNIFIED:
        return system_budget
    if accelerator_memory_bytes is None:
        return system_budget

    accelerator_budget = accelerator_memory_bytes * 80 // 100
    return max(system_budget, accelerator_budget)


def build_capability_profile(
    *,
    operating_system: OperatingSystem,
    architecture: str,
    logical_cpu_count: int,
    total_ram_bytes: int,
    available_ram_bytes: int,
    disk_free_bytes: int,
    memory_architecture: MemoryArchitecture,
    accelerator: AcceleratorKind,
    accelerator_memory_bytes: int | None,
    available_backends: tuple[InferenceBackend, ...],
) -> CapabilityProfile:
    budget = estimate_safe_model_budget(
        total_ram_bytes=total_ram_bytes,
        available_ram_bytes=available_ram_bytes,
        memory_architecture=memory_architecture,
        accelerator_memory_bytes=accelerator_memory_bytes,
    )
    return CapabilityProfile(
        operating_system=operating_system,
        architecture=architecture,
        logical_cpu_count=logical_cpu_count,
        total_ram_bytes=total_ram_bytes,
        available_ram_bytes=available_ram_bytes,
        disk_free_bytes=disk_free_bytes,
        memory_architecture=memory_architecture,
        accelerator=accelerator,
        accelerator_memory_bytes=accelerator_memory_bytes,
        available_backends=available_backends,
        estimated_safe_model_bytes=budget,
    )
