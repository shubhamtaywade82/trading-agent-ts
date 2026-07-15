class User < ApplicationRecord
  include Searchable

  has_many :orders, dependent: :destroy
  has_one :profile

  validates :email, presence: true, uniqueness: true
  validates :name,
    presence: true,
    length: { maximum: 100 }

  before_save :normalize_email
  after_create_commit :enqueue_welcome_email

  scope :active, -> { where(active: true) }

  private

  def normalize_email
    self.email = email.downcase.strip
  end

  def enqueue_welcome_email
    WelcomeEmailJob.perform_later(id)
  end
end
