/** Response bodies copied from AutoDL's official API docs, so the parsers are tested
 *  against the real shapes rather than shapes we invented. */

export const balanceResponse = {
  code: "Success",
  msg: "",
  request_id: "req-balance",
  data: { assets: 12_340, accumulate: 987_650, voucher_balance: 5_000 },
};

export const sampleInstanceRaw = {
  created_at: "2025-12-15T17:30:54+08:00",
  uuid: "pro-76576c61fdf1",
  machine_id: "4d67438b4f",
  machine_alias: "",
  region_sign: "neimeng-C",
  region_name: "内蒙C区",
  status: "running",
  sub_status: "",
  status_at: "2025-12-15T17:31:05+08:00",
  start_mode: "gpu",
  charge_type: "payg",
  req_gpu_amount: 1,
  expired_at: { Time: "0001-01-01T00:00:00Z", Valid: false },
  started_at: { Time: "2025-12-15T17:31:05+08:00", Valid: true },
  stopped_at: { Time: "0001-01-01T00:00:00Z", Valid: false },
  name: "zqAPI创建",
  timed_shutdown_at: { Time: "0001-01-01T00:00:00Z", Valid: false },
  gpu_spec_uuid: "pro6000-p",
};

export const instanceListResponse = {
  code: "Success",
  msg: "",
  request_id: "req-list",
  data: {
    list: [sampleInstanceRaw],
    page_index: 1,
    page_size: 1,
    offset: 0,
    max_page: 1,
    result_total: 1,
    page: 1,
  },
};

export const snapshotResponse = {
  code: "Success",
  msg: "",
  request_id: "req-snapshot",
  data: {
    region_sign: "bj-B1",
    payg_price: 1970,
    origin_pay_price: 3030,
    snapshot_gpu_alias_name: "NVIDIA RTX PRO 6000",
    chip_corp: "nvidia",
    cpu_arch: "x86",
    usage_info: {
      container_id: "autodl-pro-76576c61fdf1",
      cpu_usage_percent: 3.34,
      mem_usage_percent: 1.26,
      mem_usage: 270_528_512,
      mem_limit: 21_474_836_480,
      root_fs_used_size: 54_435_840,
      root_fs_total_size: 31_526_391_808,
      data_disk_total_size: 0,
      data_disk_used_size: 0,
    },
    expand_system_disk_size: 32_212_254_720,
    system_init_disk_size: 32_212_254_720,
    ssh_command: "ssh -p 34222 root@connect.xxx.autodl.com",
    proxy_host: "connect.xxx.autodl.com",
    root_password: "jbeOXgTWUxq+",
    ssh_port: 34222,
    jupyter_token: "jt-secret",
    jupyter_domain: "a1-765793a1f226.xxx.autodl.com:8443",
    service_6006_domain: "u1-h1tr7dnhvxyvm4uacvq9.xxx.autodl.com:8443",
    service_6006_port_protocol: "http",
    service_6008_domain: "uu1-yufv2v0fcxtvr5lv4j80.xxx.autodl.com:8443",
    service_6008_port_protocol: "http",
  },
};

export const createResponse = {
  code: "Success",
  msg: "",
  request_id: "req-create",
  data: "pro-76419909953e",
};

export const emptySuccess = { code: "Success", msg: "", data: null, request_id: "req-empty" };
