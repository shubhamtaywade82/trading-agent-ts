require "rails_helper"

RSpec.describe User, type: :model do
  it "normalizes email before save" do
    user = described_class.create!(email: "A@B.COM", name: "A")
    expect(user.email).to eq("a@b.com")
  end

  it "requires a name" do
    expect(described_class.new(email: "a@b.com")).not_to be_valid
  end
end
