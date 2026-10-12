# AutoJev tokenizer metadata

`autojev-qwen35-tokenizer.json.gz` contains public tokenizer vocabulary, merges, special-token definitions and classifier labels extracted from the installed AutoJev Q4_K_M GGUF. It contains no model weights, credentials, requests or article content.

The Qwen35 pre-tokenizer regex matches the serving jev.cpp implementation. The JavaScript tokenizer counts the complete rendered user prompt. A separate framing reserve covers chat-template/special-token overhead; these counts are preflight measurements, not billed/evaluated usage.

Uncompressed SHA256: `a77a45a635f94562a03458f9e4d50f2e2d77fe5c30b86d1bd09f386e8fb8d7a3`. Integrity is checked at load. The model identity is `autojev-27b-q4_k_m`. A different tokenizer/model must not be guessed equivalent; unknown model families use the conservative UTF8 bound or explicit exact evaluation/review. Updating the serving tokenizer requires an independently verified artifact update and regressions.

Provenance is retained in `tmp/jev-tokenizer-extraction.log` and the extraction script during this investigation. Qwen tokenizer data uses the base model's Apache-2.0 license. This artifact is tokenizer metadata only and does not distribute the AutoJev trained weights.
