# Reverse proxy contract (Etapa 12.2)

Requisitos para qualquer proxy ou load balancer à frente do backend.
Independe de fornecedor. O backend escuta HTTP puro em `PORT`, e TLS termina
no proxy.

**Uma instância só:** o proxy aponta para exatamente um backend. Sticky
sessions e balanceamento entre réplicas ficam para a Etapa 12.5.

## TLS

- Termine TLS 1.2+ no proxy; redirecione HTTP → HTTPS.
- Defina HSTS no proxy ou, na app, com `SECURITY_HSTS_MAX_AGE_SECONDS`, só com TLS garantido no domínio inteiro.
- O backend não recebe certificados. Entre o proxy e o backend use uma rede privada ou TLS interno próprio.

## Endereço do cliente

- O proxy deve **sobrescrever** ou **anexar** `X-Forwarded-For` com o endereço do peer que ele vê. Nunca repasse o header do cliente como "confiável".
- `TRUST_PROXY` no backend deve corresponder exatamente à topologia:
  - um proxy direto: `TRUST_PROXY=1`, ou o IP/CIDR dele;
  - uma cadeia CDN → LB: o número de hops, ou os CIDRs de cada um;
  - acesso direto, sem proxy: `false`.
- `TRUST_PROXY=true` é recusado.
- Com a configuração errada, todos os clientes caem no mesmo bucket de rate limit (o IP do proxy), ou um cliente consegue escolher o próprio IP.
- Verificação: faça login e confira `staff_sessions.ip_address` e `audit_logs.ip_address`, que devem ter o IP real do cliente.

## WebSocket

Dois paths fazem upgrade HTTP/1.1 no mesmo porto: `/api/v1/realtime`
(Player/Staff) e `/api/v1/agent` (Host Agent). Query string é recusada.

- Repasse `Upgrade` e `Connection`, com HTTP/1.1 até o backend.
- **Idle timeout** acima de:
  - `AGENT_HEARTBEAT_INTERVAL` (10 s), com margem: o Agent manda heartbeat a cada intervalo;
  - para o realtime, que não tem ping (só push), o maior intervalo sem eventos que você quer tolerar. Os clientes reconectam e refazem GET, então um corte não perde estado, mas deve ser raro: recomenda-se ≥ 60 s, idealmente próximo do TTL do access token.
- Sem buffering de respostas nem de frames WebSocket (streaming), para os wake-ups não atrasarem.
- Preserve o header `Origin`: o realtime o valida contra `REALTIME_ALLOWED_ORIGINS`.
- Tamanho de frame: o backend limita a 16 KiB no realtime e 128 KiB no Agent. O proxy não pode limitar abaixo disso.

## HTTP

- Limite de body no proxy ≥ 100 kB (o limite JSON do backend) e sem margem excessiva: 1 MB é suficiente.
- Timeouts de leitura acima do `DB_STATEMENT_TIMEOUT_MS` (10 s): uma request lenta termina no backend, não no proxy.
- Não faça cache de `/api/v1/*`. As respostas sensíveis já mandam `Cache-Control: no-store`.
- Health do LB: `GET /api/v1/ready` para tráfego e `GET /api/v1/live` para o processo. Nunca use `/api/v1/health` (legado) para decidir tráfego.
- Durante o deploy recreate não há outra instância: espere downtime curto; o proxy deve responder 502/503 até `/ready` voltar.
- Não exponha `/docs` publicamente se `SWAGGER_ENABLED=true`.

## Exemplo ilustrativo (não normativo)

```nginx
location /api/v1/ {
  proxy_pass http://backend:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;   # map $http_upgrade
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_read_timeout 120s;
  proxy_buffering off;
  client_max_body_size 1m;
}
# Backend: TRUST_PROXY=<IP ou CIDR deste proxy>
```
