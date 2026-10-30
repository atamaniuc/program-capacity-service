{{- define "capacity.labels" -}}
app.kubernetes.io/name: capacity
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "capacity.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end }}

{{- define "capacity.secretName" -}}
{{ default "capacity-database" .Values.database.existingSecret }}
{{- end }}

{{/* Env shared by api, worker and the migrate Job. */}}
{{- define "capacity.envFrom" -}}
- configMapRef:
    name: capacity-env
- secretRef:
    name: {{ include "capacity.secretName" . }}
{{- end }}

{{- define "capacity.probes" -}}
readinessProbe:
  httpGet:
    path: /health/ready
    port: {{ .Values.ports.ops }}
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 10
livenessProbe:
  httpGet:
    path: /health/live
    port: {{ .Values.ports.ops }}
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 5
{{- end }}
