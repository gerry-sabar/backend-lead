'use strict';

// Running turnover totals, maintained in the same transaction (and under the same
// row lock) as the balance. Like balance, they are a cache of the ledger:
// required = SUM(turnover_required_delta), accrued = SUM(turnover_accrued_delta).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('wallets', 'turnover_required', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.addColumn('wallets', 'turnover_accrued', {
      type: Sequelize.DECIMAL(36, 18),
      allowNull: false,
      defaultValue: '0',
    });
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        ADD CONSTRAINT wallets_balance_nonneg_chk CHECK (balance >= 0),
        ADD CONSTRAINT wallets_turnover_nonneg_chk
          CHECK (turnover_required >= 0 AND turnover_accrued >= 0);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE wallets
        DROP CONSTRAINT IF EXISTS wallets_balance_nonneg_chk,
        DROP CONSTRAINT IF EXISTS wallets_turnover_nonneg_chk;
    `);
    await queryInterface.removeColumn('wallets', 'turnover_required');
    await queryInterface.removeColumn('wallets', 'turnover_accrued');
  },
};
