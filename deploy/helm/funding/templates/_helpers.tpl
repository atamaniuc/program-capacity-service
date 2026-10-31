{{- define "funding.labels" -}}
app.kubernetes.io/name: funding
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "funding.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end }}

{{- define "funding.secretName" -}}
{{ default "funding-database" .Values.database.existingSecret }}
{{- end }}

{{/* Env shared by api, worker and the migrate Job. */}}
{{- define "funding.envFrom" -}}
- configMapRef:
    name: funding-env
- secretRef:
    name: {{ include "funding.secretName" . }}
{{- end }}

{{- define "funding.probes" -}}
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

{{/* The images run as USER node; a numeric uid lets the kubelet verify runAsNonRoot. */}}
{{- define "funding.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "funding.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end }}
