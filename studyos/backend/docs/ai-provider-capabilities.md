# AI provider capability decisions

Verified against the configured hosted endpoint and model on 2026-08-14:

- Endpoint: `https://integrate.api.nvidia.com/v1/chat/completions`
- Model: `nvidia/nemotron-3-super-120b-a12b`
- Native JSON object mode: **enabled**. A live request with `response_format: {"type":"json_object"}` returned HTTP 200 and valid JSON. `GenerationPolicy.ResponseMode.JSON` now sends this field.
- JSON-schema guided decoding: **unsupported on this hosted endpoint/model**. A live request using NVIDIA's documented `nvext.guided_json` shape returned HTTP 400. StudyOS therefore keeps typed parsing, conservative repair, failure telemetry, and one task-level retry.
- Prefix/KV caching: **skipped for the hosted endpoint**. NVIDIA documents `NIM_ENABLE_KV_CACHE_REUSE=1` for operators of self-hosted NIM containers, but StudyOS uses NVIDIA's hosted `integrate.api.nvidia.com` service and cannot set that server environment variable. The hosted response exposes prompt/completion/total tokens but no cached-token count, so StudyOS does not claim prefix-cache savings.
- Reasoning: explicitly controlled with `chat_template_kwargs.enable_thinking`; non-reasoning policies send `false` rather than omitting the setting.

References:

- NVIDIA NIM structured generation: https://docs.nvidia.com/nim/large-language-models/1.11.0/structured-generation.html
- NVIDIA NIM configuration and KV cache reuse: https://docs.nvidia.com/nim/large-language-models/1.10.0/configuration.html
- NVIDIA NIM API reference: https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html

These decisions must be reverified before changing the hosted model or moving to a self-hosted NIM.
