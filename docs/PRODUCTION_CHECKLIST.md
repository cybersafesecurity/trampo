# Before carrying real passengers in Uganda

This repository is a functional prototype. Checking items below requires business operations, legal review, infrastructure, and external providers; they are not accomplished by deploying the web build.

## Identity, drivers, and payments

- [ ] Integrate Uganda mobile-number OTP/identity verification. Production currently blocks unverified accounts; no OTP provider is connected.
- [ ] Replace reference-only driver documents with secure upload, malware scanning, restricted retention, and verified permit/insurance/identity checks.
- [ ] Conduct real background checks, vehicle inspections, VIP chauffeur assessment, and safety training. Demo approval is not KYC.
- [ ] Create the first operations account using `scripts/create-admin.js`; never deploy seed demo credentials.
- [ ] Integrate MTN MoMo/Airtel Money or another licensed payment provider with server-side verification, idempotent webhooks, receipts, refunds, reconciliation, and driver payouts. Current payment choices are arrangements to pay the driver, not processed payments.
- [ ] Confirm transport, tax, insurance, consumer protection, and employment/contractor obligations with Ugandan counsel and regulators.

## Safety and privacy

- [ ] Contract and test a real 24/7 safety response process and emergency escalation. The current SOS only writes an operations alert.
- [ ] Add device attestation, mock-location/spoof detection, impossible-travel checks, and signed device sessions. Client-reported GPS is not trustworthy by itself.
- [ ] Add route-deviation and prolonged-stop analysis using real road routes; test false positives and missed events.
- [ ] Obtain appropriate consent for trusted-contact sharing and any future audio recording. Calls are not recorded today.
- [ ] Review obligations under Uganda's Data Protection and Privacy Act and applicable Personal Data Protection Office requirements; define retention, deletion, access, breach response, and cross-border transfer controls.
- [ ] Add account recovery, session revocation, admin MFA, granular staff permissions, immutable audit storage, and secret rotation.
- [ ] Penetration-test authorization, WebSocket signaling, share links, rate limits, and location privacy. Add a deployment-specific CSP/frame-ancestors policy.

## Fleet, maps, and reliability

- [ ] Recruit real drivers and establish service areas; the demo fleet is only around Kampala.
- [ ] Integrate production geocoding, road routing, traffic/ETA, distance metering, tolls, and fare disputes.
- [ ] Load-test dispatch and location updates; migrate SQLite to a managed relational database before multi-instance deployment.
- [ ] Deploy self-hosted LiveKit or equivalent media infrastructure plus coturn; test real Ugandan carrier networks and restrictive NATs.
- [ ] Add monitoring, alerting, backups, restore drills, incident response, and durable scheduled-dispatch jobs.
- [ ] Build native driver/rider shells or a hardened PWA with background-location behavior, battery/network testing, and app-store compliance.
- [ ] Publish real support contacts, terms, privacy notice, insurance details, and VIP service guarantees only after they are operationally true.

**Head office recorded in the product:** Plot 14 Martyrs Drive, Ntinda Ministers Village, Kampala, Uganda. Confirm operating hours and public contact details before publishing them.
