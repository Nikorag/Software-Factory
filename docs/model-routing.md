# Model routing
Local calls are strictly sequential (`maxConcurrentRequests: 1`) because of 32 GB unified memory. Local Qwen handles classification and independent review; Claude handles specification, implementation and final review.
