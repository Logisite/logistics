# operators/

One JSON file per deployed operator. Created at provisioning time, not committed as demo data.

Format:

```json
{
  "desiredVersion": "0.1.0"
}
```

`desiredVersion` is checked against `GET /health {version, sha}` at deploy time (D-077, D-078). Promotion never happens mid-ops. Rollback is previous tag redeploy.

Do not commit real operator files — this directory is per-deployment state.
