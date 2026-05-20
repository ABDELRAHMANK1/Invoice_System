export const sampleFileRow = {
  id: "aaaaaaaa-1111-1111-1111-111111111111",
  phone_number: "+31612345678",
  file_key: "files/2026/05/inv-0001.pdf",
  file_type: "pdf" as const,
  file_name: "inv-0001.pdf",
  file_size: 51234,
  mime_type: "application/pdf",
  status: "pending" as const,
  error_message: null,
  invoice_direction: "inkoop" as const,
  created_at: "2026-05-10T08:30:00Z",
  updated_at: "2026-05-10T08:30:00Z",
};

export const sampleClientRow = {
  id: "cccccccc-1111-1111-1111-111111111111",
  name: "Nema Food B.V.",
  phone_number: "+31612345678",
  email: "info@nemafood.nl",
  address: "Keizersgracht 1",
  city: "Amsterdam",
  country: "NL",
  btw_number: "NL000000000B01",
  kvk_number: "12345678",
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
};
