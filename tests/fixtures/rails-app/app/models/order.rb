class Order < ApplicationRecord
  belongs_to :user

  validates :total, numericality: { greater_than_or_equal_to: 0 }

  scope :recent, -> { order(created_at: :desc) }
end
