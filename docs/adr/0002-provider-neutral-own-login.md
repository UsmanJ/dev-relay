# ADR 0002: Provider-neutral engine, bring-your-own-login adapters

- Status: accepted (2026-11-02)

## Context
Tools and terms change quickly, and different users have different subscriptions. Vendors restrict how subscription credentials may be used by third-party software.

## Decision
- The orchestrator depends only on `StructuredAgent` and a capability registry (`roles`, `writeCapable`, `billing`, `kind`). Vendor logic lives in adapters.
- Shipped adapters spawn **unmodified official CLIs** that the user installed and signed into. DevRelay never handles credentials, and it strips API-key environment variables from child processes.
- Billing classes are explicit. `api-metered` adapters are separate and disabled unless the user opts in.

## Consequences
- New CLIs or APIs can be added without touching the workflow engine.
- Each adapter must document the vendor's authentication terms (docs/PROVIDERS.md).