export const meta = {
  name: "no-write-probe",
  description: "No-write workflow probe",
  phases: [{ title: "Probe", detail: "return constant result" }],
};

phase("Probe");
log("no-write probe entered");
return { ok: true };
