# LLM refactor steps

1. Provider adapters (anthropic/openai/google) with completeText/completeDocument.
2. Attachment model (text/image/document) + upstream conversions.
3. Normalize Prompt shape (system + userText + attachments).
4. Centralize usage normalization + streaming capability gate.
5. Test helpers (PDF + prompt mocks) + reuse.
6. Resolve document handling in one function.
