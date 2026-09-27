# GSM ↔ Asterisk ↔ ElevenLabs call console

A self-hosted web console for starting outbound GSM calls and watching their live status. An IP-peered GSM-to-SIP gateway connects to Asterisk, which bridges calls to an ElevenLabs voice agent over the official SIP trunk. Inbound calls on a gateway SIM also reach the agent. No call transfer is configured.

```text
Mobile network ⇄ GSM/SIP gateway ⇄ Asterisk (Docker, host network) ⇄ ElevenLabs SIP agent
                                        ⇅
                               Private web dashboard
```

**Bring your own:** Linux host with a public IPv4 address, a reachable GSM/SIP gateway with a working SIM, an ElevenLabs account, a DNS-independent public IP for the Asterisk host, Docker Engine + Compose, Python 3, and SSH access. This repository has **no live IPs, phone numbers, credentials, or call history**. The dashboard does not run calls without real SIP infrastructure.

## Files

| Path | Purpose |
|------|---------|
| `asterisk/compose.yaml` | Asterisk and dashboard containers, both using host networking |
| `asterisk/etc/pjsip.conf.example` | IP peer for the gateway and TCP/digest ElevenLabs trunk |
| `asterisk/etc/extensions.conf.example` | Inbound SIM → ElevenLabs agent dialplan |
| `asterisk/etc/manager.conf.example` | Loopback-only Asterisk Manager Interface (AMI) |
| `asterisk/secrets.env.example` | Required configuration names, not real values |
| `scripts/configure.py` | Validates settings and renders private Asterisk config |
| `scripts/start.sh` | Configure, build and start both containers |
| `dashboard/` | Node.js backend and browser interface; no package install required |

Generated `asterisk/secrets.env` and `asterisk/etc/{pjsip,extensions,manager}.conf` are excluded from Git. Call history is kept **in memory** and disappears when the dashboard restarts.

## 1. Configure the gateway and ElevenLabs

### Gateway

Configure a GSM-to-SIP gateway that supports IP peers (no SIP REGISTER required):

1. Create a SIP endpoint/peer targeting **your Asterisk host's public IPv4** on UDP port **5060**. Use G.711 μ-law/A-law, RFC 4733 DTMF, NAT handling, and disable direct media.
2. Route inbound calls from the intended SIM/port to that SIP peer. If existing routes exist, place the new inbound rule before any broader match; preserve unrelated routes.
3. Permit outbound SIP calls **from that Asterisk peer** to your gateway's desired GSM port/group. The dashboard dials the gateway in its national numbering format.
4. Make the gateway reachable at a stable public IPv4 address; allow signaling from the Asterisk host. Only point `GATEWAY_PUBLIC_IP` at an address Asterisk can reach.

Gateway menus differ by vendor and firmware. The supplied Asterisk peer is IP-identified (`match=GATEWAY_PUBLIC_IP`) and does not request gateway registration. A gateway that requires registration needs a different PJSIP configuration.

### ElevenLabs

1. In the ElevenLabs dashboard, create a Conversational AI / ElevenAgents agent. Choose a voice, prompt, first message, and language. A multilingual voice needs a compatible multilingual TTS model. Do **not** enable transfer tools for this dialplan.
2. Under **Agents → Phone Numbers**, import a **SIP trunk** number/identifier. Set its identifier to your `EL_SIP_ID` (for example, `demo-sim`); assign it to the agent. The identifier is a SIP Request-URI user, **not** necessarily the SIM's phone number.
3. Choose **TCP port 5060** inbound trunk signaling and **disabled media encryption** for this G.711 example. Set the inbound allowed address to `ASTERISK_PUBLIC_IP` and digest credentials matching `EL_SIP_USER` / `EL_SIP_PASS` in your env file.
4. The ElevenLabs SIP auth realm is `LiveKit`. The Asterisk template uses that realm. The outbound INVITE must target `sip:<EL_SIP_ID>@sip.rtc.elevenlabs.io:5060;transport=tcp`; omitting the user will not select the imported trunk number.

See the [ElevenLabs SIP trunking guide](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking) and [SIP reference](https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-reference). An API key is **not** required by this dashboard; calls use SIP digest authentication.

## 2. Configure your server

Clone this repo to the Linux host, then from its root:

```bash
cp asterisk/secrets.env.example asterisk/secrets.env
chmod 600 asterisk/secrets.env
${EDITOR:-nano} asterisk/secrets.env
```

Replace every `REQUIRED_...` value. Do not commit the completed file.

| Variable | Meaning |
|----------|---------|
| `ASTERISK_PUBLIC_IP` | Public IPv4 of the Asterisk host, used in SIP/SDP and the gateway status probe |
| `GATEWAY_PUBLIC_IP` | Reachable IPv4 of the GSM/SIP gateway, used for IP identification, SIP dialing, and status |
| `EL_SIP_ID` | Imported ElevenLabs SIP number/identifier (letters, digits, `_`, `-`) |
| `EL_SIP_USER` / `EL_SIP_PASS` | ElevenLabs inbound-trunk digest username/password |
| `DIAL_COUNTRY_CODE` | International calling code digits **without** `+` |
| `DIAL_NATIONAL_PREFIX` | Prefix the gateway expects for national outbound calls (often `0`) |
| `DIAL_LOCAL_LENGTH` | Number of digits **after** the national prefix; 5–12 |
| `AMI_SECRET` / `DASHBOARD_TOKEN` | Leave empty; generated randomly on first configuration. Keep them private. |

The dashboard accepts `+<country code><local digits>`, `<national prefix><local digits>`, or local digits alone; it sends `<national prefix><local digits>` to the gateway. The configuration generator validates public IP fields, phone rules and SIP identifiers before writing private configs. If the gateway expects a different dialing plan, adapt the normalization function in `dashboard/server.js`.

### Firewall

- Allow **5060/UDP only from the gateway** to Asterisk for SIP signaling.
- Allow **5060/TCP** to Asterisk for the ElevenLabs trunk. ElevenLabs may use changing source IPs; rely on the configured digest credentials.
- Allow **10000–20000/UDP** RTP between Asterisk and the SIP peers (narrow sources where your routing permits).
- Keep **5038/TCP (AMI)** and **8088/TCP (dashboard)** on **127.0.0.1 only**. Do not expose them publicly.
- Asterisk and the dashboard use Docker **host networking** so loopback-only AMI works across the two processes. Check for existing port conflicts first.

## 3. Start the stack

```bash
./scripts/start.sh
```

This invokes `scripts/configure.py`, generates missing AMI/dashboard tokens, renders Asterisk config in `asterisk/etc/`, builds the dashboard image, and starts both containers. It does **not** modify gateway or ElevenLabs settings. On a later SIP/AMI configuration change, apply a restart:

```bash
docker compose -f asterisk/compose.yaml restart asterisk dashboard
```

Read the dashboard token on the server without pasting it into logs:

```bash
sed -n 's/^DASHBOARD_TOKEN=//p' asterisk/secrets.env
```

From your workstation, forward the private web interface over SSH (replace the placeholder with your own SSH host):

```bash
ssh -N -L 8088:127.0.0.1:8088 your-ssh-host
```

Open [http://127.0.0.1:8088](http://127.0.0.1:8088), enter the token, then enter a mobile number in your configured dial format. The call row progresses through **Ringing → Connected → Ended** (or **Failed**). **End call** hangs up the active GSM leg. The server rejects concurrent calls to the same number.

## Check operation

On the server, from the repository root:

```bash
# Containers and Asterisk health
docker compose -f asterisk/compose.yaml ps

# Gateway contact should show Avail with RTT; ElevenLabs may show NonQual (no SIP OPTIONS).
docker exec elevenlabs-asterisk asterisk -rx 'pjsip show contacts'

# Active Asterisk channels
docker exec elevenlabs-asterisk asterisk -rx 'core show channels'

# Dashboard API health; read token without printing it
TOKEN=$(sed -n 's/^DASHBOARD_TOKEN=//p' asterisk/secrets.env)
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8088/api/status

# Diagnostics
docker logs --since 10m elevenlabs-dashboard
docker logs --since 10m elevenlabs-asterisk
```

**End-to-end check:** Place a call through the interface, answer the mobile, confirm two-way audio with the ElevenLabs agent, then hang up. A green gateway indicator means a SIP response from the gateway, not that a SIM is registered or has credit. SIP/RTP reachability and a real answered call are separate checks.

## Security and limitations

- Never commit generated `.conf` files, `asterisk/secrets.env`, recordings, call logs, or real customer data. A clean Git history is intentional.
- HTTP dashboard authentication uses a bearer token over **loopback**. Use SSH forwarding or a properly authenticated TLS reverse proxy; never expose raw HTTP/AMI to the internet.
- The interface authorizes every API request, but static HTML/CSS/JS are public on the loopback service. Do not embed secrets in frontend files.
- Asterisk AMI may emit call metadata. The dashboard keeps recent call states in memory only; Asterisk's own logging policy is separate.
- The included dialplan has no transfers or emergency-number logic. Use it only with a gateway and destinations you are authorized to call.
