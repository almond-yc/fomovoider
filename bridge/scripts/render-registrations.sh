#!/bin/sh
# Renders the appservice registrations Synapse loads from the tokens in .env.
set -eu
: "${WA_AS_TOKEN:?}" "${WA_HS_TOKEN:?}" "${FB_AS_TOKEN:?}" "${FB_HS_TOKEN:?}" "${ADAPTER_AS_TOKEN:?}" "${ADAPTER_HS_TOKEN:?}"

# bridge <file> <id> <url> <as_token> <hs_token> <bot localpart> <ghost prefix>
bridge() {
  cat > "/appservices/$1.yaml" <<EOF
id: $2
url: $3
as_token: "$4"
hs_token: "$5"
sender_localpart: $6
rate_limited: false
namespaces:
  users:
    - regex: '^@$6:bridge\.local$'
      exclusive: true
    - regex: '^@$7.*:bridge\.local$'
      exclusive: true
de.sorunome.msc2409.push_ephemeral: true
receive_ephemeral: true
EOF
}

bridge whatsapp whatsapp http://whatsapp:29318 "$WA_AS_TOKEN" "$WA_HS_TOKEN" whatsappbot whatsapp_
bridge messenger facebook http://messenger:29319 "$FB_AS_TOKEN" "$FB_HS_TOKEN" facebookbot facebook_

# The adapter owns the @fv_<accountId> users it acts as.
cat > /appservices/adapter.yaml <<EOF
id: fomovoider
url: http://adapter:8080
as_token: "$ADAPTER_AS_TOKEN"
hs_token: "$ADAPTER_HS_TOKEN"
sender_localpart: fomovoider
rate_limited: false
namespaces:
  users:
    - regex: '^@fv_.*:bridge\.local$'
      exclusive: true
EOF
echo "rendered appservice registrations"
