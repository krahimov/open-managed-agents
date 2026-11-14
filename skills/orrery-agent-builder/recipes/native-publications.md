# Recipe: Native Publications

Use native publications when the agent should appear inside a third-party
product as its own teammate identity.

## Slack

```bash
oma slack publish <agent-id> --env <env-id> --persona "<Bot Name>"
```

The command returns a Slack manifest launch URL and a form token. A Slack admin
must create/install the app, then submit the Client ID, Client Secret, and
Signing Secret:

```bash
oma slack submit <form-token> \
  --client-id <CLIENT_ID> \
  --client-secret <CLIENT_SECRET> \
  --signing-secret <SIGNING_SECRET>
```

Verify:

```bash
oma slack list
oma slack pubs <installation-id>
oma slack get <publication-id>
```

## GitHub

```bash
oma github bind <agent-id> --env <env-id> --persona "<Bot Name>"
```

The command returns a manifest start URL. A GitHub org owner may need to
approve installation.

Verify:

```bash
oma github list
oma github pubs <installation-id>
oma github get <publication-id>
```

## Linear

```bash
oma linear publish <agent-id> --env <env-id> --persona "<Bot Name>"
```

The command returns app config values and a form token. A Linear admin must
create the OAuth app, then submit the returned Client ID, Client Secret, and
Webhook signing secret:

```bash
oma linear submit <form-token> \
  --client-id <CLIENT_ID> \
  --client-secret <CLIENT_SECRET> \
  --webhook-secret <lin_wh_...>
```

Verify:

```bash
oma linear list
oma linear pubs <installation-id>
oma linear get <publication-id>
```

## Handoff Rule

If the user is not an admin, use the provider handoff command and give the
admin the generated URL:

```bash
oma slack handoff <form-token>
oma github handoff <form-token>
oma linear handoff <form-token>
```
