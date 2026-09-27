export const up = (pgm) => {
  pgm.addColumn('users', {
    password_hash: { type: 'text', notNull: false },
  })
}

export const down = (pgm) => {
  pgm.dropColumn('users', 'password_hash')
}
