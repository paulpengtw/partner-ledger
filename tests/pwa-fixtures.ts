import type { CounterpartyOptions, LedgerTransaction, ListResult } from '../src/api'

export const CACHED_OPTIONS: CounterpartyOptions = {
  schema_version: 'schema-cached',
  categories: ['餐飲', '交通'],
  counterparties: ['全聯'],
  partners: ['阿哲', '小語'],
}

export const REFRESHED_OPTIONS: CounterpartyOptions = {
  schema_version: 'schema-refreshed',
  categories: ['餐飲', '交通', '醫療'],
  counterparties: ['全聯', '家樂福'],
  partners: ['阿哲', '小語'],
}

function transaction(overrides: Partial<LedgerTransaction>): LedgerTransaction {
  return {
    txn_id: '',
    日期: '2026-08-01',
    金額: '0',
    付款人: '阿哲',
    分攤方式: '',
    分類: '餐飲',
    交易對象: '',
    記帳人: '阿哲',
    來源: 'pwa',
    沖銷txn_id: '',
    voided: false,
    ...overrides,
  }
}

export const LIST_RESULT: ListResult = {
  transactions: [
    transaction({
      txn_id: 'pay-1',
      日期: '2026-08-06',
      金額: '100',
      付款人: '阿哲',
      分類: '結清',
    }),
    transaction({
      txn_id: 'meal-1',
      日期: '2026-08-05',
      金額: '300',
      付款人: '小語',
      分攤方式: '均分',
      分類: '餐飲',
    }),
    transaction({
      txn_id: 'txn-voided',
      日期: '2026-08-04',
      金額: '100',
      付款人: '阿哲',
      分攤方式: '全額對方',
      分類: '交通',
      交易對象: '全聯',
      記帳人: '小語',
      沖銷txn_id: 'txn-reversal',
      voided: true,
    }),
    transaction({
      日期: '2026-08-03',
      金額: '80',
      付款人: '小語',
      分攤方式: '全額自己',
      來源: '手動',
    }),
  ],
  payables: {
    directions: [
      { debtor: '阿哲', creditor: '小語', outstanding: 50 },
      { debtor: '小語', creditor: '阿哲', outstanding: 0 },
    ],
  },
}

export const OVER_SETTLED_RESULT: ListResult = {
  transactions: [
    transaction({
      txn_id: 'pay-1',
      日期: '2026-08-07',
      金額: '150',
      付款人: '阿哲',
      分類: '結清',
    }),
    transaction({
      txn_id: 'meal-reversal',
      日期: '2026-08-06',
      金額: '300',
      付款人: '小語',
      分攤方式: '均分',
      分類: '餐飲',
      沖銷txn_id: 'meal-1',
    }),
    transaction({
      txn_id: 'meal-1',
      日期: '2026-08-05',
      金額: '300',
      付款人: '小語',
      分攤方式: '均分',
      分類: '餐飲',
      voided: true,
    }),
  ],
  payables: {
    directions: [
      { debtor: '阿哲', creditor: '小語', outstanding: -150 },
      { debtor: '小語', creditor: '阿哲', outstanding: 0 },
    ],
  },
}
