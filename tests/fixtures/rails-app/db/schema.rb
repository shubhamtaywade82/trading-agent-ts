ActiveRecord::Schema[7.1].define(version: 2024_01_02_000000) do
  enable_extension "plpgsql"

  create_table "users", force: :cascade do |t|
    t.string "email", null: false
    t.string "name"
    t.boolean "active", default: "true"
    t.datetime "created_at", null: false
    t.datetime "updated_at", null: false
    t.index ["email"], name: "index_users_on_email", unique: true
  end

  create_table "orders", force: :cascade do |t|
    t.references "user", null: false
    t.decimal "total", precision: 10, scale: 2
    t.timestamps
  end

  add_foreign_key "orders", "users"
end
