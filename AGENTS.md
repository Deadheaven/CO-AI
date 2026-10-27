# CO-AI verification

- For database function changes, execute a rolled-back PostgreSQL regression
  through the intended authenticated identity or worker RPCs before deployment.
  Function creation and mocked client tests do not exercise PL/pgSQL column
  ambiguity, enum assignments, or CTE execution.
- Keep contract fixtures separate from provider proof. Synthetic executor
  evidence belongs only in rolled-back tests; real verification claims need a
  recorded Sandbox operation and result for the exact proposed revision.
- Before submission media or judge readiness claims, open a real persisted run
  in the deployed UI and expand its diff and execution output. A successful
  backend run does not prove that its evidence is visible to reviewers.
- After frontend collaboration changes, use two independent browser contexts
  to check realtime delivery, reload persistence, and replay download. Record
  the backend, local-browser, and hosted-deployment results separately.
